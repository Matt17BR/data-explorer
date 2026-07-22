import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import test from "node:test";
import {
  clearEditorAcceptanceEvidence,
  redactEditorAcceptanceText,
  retainEditorAcceptanceEvidence
} from "./editor-acceptance-evidence.mjs";

const LOG_FILE_LIMIT = 512 * 1024;
const LOG_BUNDLE_LIMIT = 8 * 1024 * 1024;
const EVIDENCE_SOURCE_LIMIT = 16 * 1024 * 1024;
const EVIDENCE_SOURCE_CANDIDATE_LIMIT = 64;
const EVIDENCE_SCAN_LIMIT = 64 * 1024 * 1024;
const MANIFEST_ENTRY_LIMIT = 4_000;
const FAILURE_FILE_LIMIT = 128 * 1024;

function syntheticCredential(...segments) {
  return segments.join("");
}

test("text redaction covers quoted JSON, generic URI userinfo, and signed query parameters", () => {
  const tokenFixtures = [
    syntheticCredential("glpat", "-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
    syntheticCredential("xox", "b-", "123456789012", "-abcdefghijklmnopqrst"),
    syntheticCredential("sk", "-proj-", "abcdefghijklmnopqrstuvwx"),
    syntheticCredential("hf", "_", "abcdefghijklmnopqrstuvwxyz123456"),
    syntheticCredential("pypi", "-", "abcdefghijklmnopqrstuvwxyz123456"),
    syntheticCredential("AI", "za", "abcdefghijklmnopqrstuvwxyz123456"),
    syntheticCredential("sk", "_live_", "abcdefghijklmnopqrstuvwxyz"),
    syntheticCredential("ya", "29.", "abcdefghijklmnopqrstuvwxyz"),
    syntheticCredential("sq0", "atp-", "abcdefghijklmnopqrstuvwxyz"),
    syntheticCredential("ey", "Jabcde.abcdefghij.klmnopqrst")
  ];
  const secrets = [
    "quoted-api-key",
    "quoted-refresh-token",
    "single-quoted-secret",
    "database-password",
    "single-userinfo-token",
    "aws-signature",
    "azure-signature",
    "google-signature",
    "azure-account-key",
    "npm-auth-value",
    "docker-auth-value",
    ...tokenFixtures
  ];
  const text = [
    '{"apiKey":"quoted-api-key","refreshToken": "quoted-refresh-token"}',
    "{'clientSecret': 'single-quoted-secret'}",
    "postgresql://database-user:database-password@database.example/app",
    "ssh://single-userinfo-token@server.example/home",
    "https://bucket.example/object?X-Amz-Signature=aws-signature&safe=value",
    "https://account.example/blob?sv=1&sig=azure-signature",
    "gs://bucket/object?X-Goog-Signature=google-signature",
    "AccountKey=azure-account-key",
    "_auth=npm-auth-value",
    '{"auth":"docker-auth-value"}',
    ...tokenFixtures
  ].join("\n");

  const redacted = redactEditorAcceptanceText(text);
  assert.equal(typeof redacted, "string");
  for (const secret of secrets) assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /"apiKey":"<redacted>"/u);
  assert.match(redacted, /'clientSecret': '<redacted>'/u);
  assert.match(redacted, /postgresql:\/\/<redacted>@database\.example/u);
  assert.match(redacted, /ssh:\/\/<redacted>@server\.example/u);
  assert.match(redacted, /X-Amz-Signature=<redacted>/u);
  assert.match(redacted, /sig=<redacted>/u);
  assert.match(redacted, /X-Goog-Signature=<redacted>/u);
  assert.match(redacted, /AccountKey=<redacted>/u);
  assert.match(redacted, /_auth=<redacted>/u);
  assert.match(redacted, /"auth":"<redacted>"/u);
  assert.equal(redacted.includes("glpat-"), false);
  assert.equal(redacted.includes("xoxb-"), false);
});

test("text redaction normalizes security escapes before removing credentials", () => {
  const secrets = [
    "escaped-userinfo",
    "escaped-credential",
    "escaped-access-key",
    "escaped-signature",
    "escaped-private-key",
    "nested-credential"
  ];
  const text = [
    String.raw`{"url":"https:\/\/diagnostic-user:escaped-userinfo@example.test/private"}`,
    String.raw`{"creden\u0074ial":"escaped-credential"}`,
    String.raw`{"awsAccessKeyId":"escaped-access-key"}`,
    String.raw`{"url":"https://bucket.example/object?safe=1\u0026X-Amz-Signature=escaped-signature"}`,
    String.raw`private\x4bey=escaped-private-key`,
    String.raw`{"creden\u005cu0074ial":"nested-credential"}`
  ].join("\n");

  const redacted = redactEditorAcceptanceText(text);
  assert.equal(typeof redacted, "string");
  for (const secret of secrets) assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /https:\/\/<redacted>@example\.test/u);
  assert.match(redacted, /"credential":"<redacted>"/u);
  assert.match(redacted, /"awsAccessKeyId":"<redacted>"/u);
  assert.match(redacted, /X-Amz-Signature=<redacted>/u);
  assert.match(redacted, /privateKey=<redacted>/u);
  assert.equal(
    redactEditorAcceptanceText(
      String.raw`-----BEGIN\u005cu0020OPENSSH\u005cu0020PRIVATE\u005cu0020KEY-----\nnested-private`
    ),
    undefined
  );
});

test("text redaction covers Windows separators, casing, JSON escapes, and file URIs", () => {
  const profile = String.raw`C:\Users\Alice Smith\AppData\Roaming\Cursor\User`;
  const temporaryRoot = String.raw`\\BuildServer\Open Wrangler\Private Root`;
  const text = [
    profile,
    "c:/users/ALICE SMITH/appdata/roaming/cursor/user",
    JSON.stringify({ profile }),
    String.raw`C:\/Users\/Alice Smith\/AppData\/Roaming\/Cursor\/User`,
    "file:///C:/Users/Alice%20Smith/AppData/Roaming/Cursor/User",
    String.raw`file:\/\/\/c:\/users\/ALICE%20SMITH\/appdata\/roaming\/cursor\/user`,
    "file://localhost/C:/Users/Alice%20Smith/AppData/Roaming/Cursor/User",
    "file://LOCALHOST/c%3a/Users/Alice%20Smith/AppData/Roaming/Cursor/User",
    "vscode-file://vscode-app/c:/Users/Alice%20Smith/AppData/Roaming/Cursor/User",
    "vscode-userdata:/C:/Users/Alice%20Smith/AppData/Roaming/Cursor/User",
    temporaryRoot,
    "//buildserver/open wrangler/private root",
    "file://BuildServer/Open%20Wrangler/Private%20Root",
    String.raw`file:\/\/buildserver\/open%20wrangler\/private%20root`
  ].join("\n");

  const redacted = redactEditorAcceptanceText(text, [
    [profile, "<profile>"],
    [temporaryRoot, "<editor-temp>"]
  ]);
  assert.equal(typeof redacted, "string");
  assert.equal(/alice(?:%20| )smith/iu.test(redacted), false);
  assert.equal(/open(?:%20| )wrangler[\\/]private(?:%20| )root/iu.test(redacted), false);
  assert.equal((redacted.match(/<profile>/gu) ?? []).length, 10);
  assert.equal((redacted.match(/<editor-temp>/gu) ?? []).length, 4);
});

test("text redaction normalizes extended UNC diagnostics and bounds encoded URI components", () => {
  const profile = String.raw`\\?\UNC\server\share name\profile`;
  const normalized = String.raw`\\SERVER\SHARE NAME\PROFILE`;
  const encodedUri = "file://server/share%20name/profile";
  const longerUri = "file://server/share%20name/profile-suffix";
  const redacted = redactEditorAcceptanceText([profile, normalized, encodedUri, longerUri].join("\n"), [
    [profile, "<profile>"]
  ]);

  assert.equal(typeof redacted, "string");
  assert.equal((redacted.match(/<profile>/gu) ?? []).length, 3);
  assert.match(redacted, /file:\/\/server\/share name\/profile-suffix/u);
});

test("normal UNC paths redact extended diagnostics and URI stack locations", () => {
  const windowsProfile = String.raw`\\server\share name\profile`;
  const posixProfile = "/home/Alice Smith/project/file.ts";
  const text = [
    String.raw`\\?\UNC\SERVER\SHARE NAME\PROFILE`,
    "file:///C:/Users/Alice%20Smith/project/file.ts:12:34",
    "vscode-file://vscode-app/c:/Users/Alice%20Smith/project/file.ts:12:34",
    "file:///home/Alice%20Smith/project/file.ts:12:34"
  ].join("\n");
  const redacted = redactEditorAcceptanceText(text, [
    [windowsProfile, "<unc-profile>"],
    [String.raw`C:\Users\Alice Smith\project\file.ts`, "<windows-file>"],
    [posixProfile, "<posix-file>"]
  ]);

  assert.equal(typeof redacted, "string");
  assert.equal(/alice(?:%20| )smith/iu.test(redacted), false);
  assert.equal(/share(?:%20| )name[\\/]profile/iu.test(redacted), false);
  assert.equal((redacted.match(/<unc-profile>/gu) ?? []).length, 1);
  assert.equal((redacted.match(/<windows-file>/gu) ?? []).length, 2);
  assert.equal((redacted.match(/<posix-file>/gu) ?? []).length, 1);
});

test("notebook-cell and remote VS Code URIs redact exact encoded source paths", () => {
  const posixSource = "/home/Alice Smith/project/file.ipynb";
  const windowsSource = String.raw`C:\Users\Alice Smith\project\file.ipynb`;
  const remoteSource = "/home/Alice Smith/project/file.py";
  const text = [
    "vscode-notebook-cell:/home/Alice%20Smith/project/file.ipynb#W0sZmlsZQ%3D%3D",
    "vscode-notebook-cell:/C:/Users/Alice%20Smith/project/file.ipynb#W0sZmlsZQ%3D%3D",
    "vscode-remote://ssh-remote+host/home/Alice%20Smith/project/file.py:4:2"
  ].join("\n");
  const redacted = redactEditorAcceptanceText(text, [
    [posixSource, "<posix-notebook>"],
    [windowsSource, "<windows-notebook>"],
    [remoteSource, "<remote-file>"]
  ]);

  assert.equal(typeof redacted, "string");
  assert.equal(/alice(?:%20| )smith/iu.test(redacted), false);
  assert.match(redacted, /vscode-notebook-cell:<posix-notebook>#/u);
  assert.match(redacted, /vscode-notebook-cell:<windows-notebook>#/u);
  assert.match(redacted, /vscode-remote:\/\/ssh-remote\+host<remote-file>:4:2/u);
});

test("hyphenated private-key labels fail closed", () => {
  assert.equal(redactEditorAcceptanceText("-----BEGIN VENDOR-OPENSSH PRIVATE KEY-----\nPRIVATE-BODY"), undefined);
});

test("CLI options, fully encoded credential URLs, and PuTTY private-key containers fail closed", () => {
  const plain = "OW_CLI_SECRET_VALUE";
  const redacted = redactEditorAcceptanceText(
    [`tool --token ${plain}`, `tool --password=${plain}`, `https%3A%2F%2Fuser%3A${plain}%40example.invalid`].join("\n")
  );
  assert.equal(redacted?.includes(plain), false);
  assert.match(redacted, /--token <redacted>/u);
  assert.match(redacted, /--password=<redacted>/u);
  assert.match(redacted, /https:\/\/<redacted>@example\.invalid/u);

  assert.equal(
    redactEditorAcceptanceText(
      ["PuTTY-User-Key-File-3: ssh-ed25519", "Encryption: none", "Private-Lines: 1", plain].join("\n")
    ),
    undefined
  );
});

test("text redaction covers basic auth, whitespace credentials, PAT aliases, and encoded delimiters", () => {
  const secrets = {
    basic: "dXNlcjpzdXBlcnNlY3JldA==",
    aws: "AWS-WHITESPACE-SECRET",
    client: "CLIENT-WHITESPACE-SECRET",
    pat: "OVSX-PAT-SECRET",
    cliPat: "CLI-PAT-SECRET",
    bareToken: "BARE-TOKEN-SECRET",
    encodedJson: "ENCODED-JSON-SECRET",
    escapedJson: "ESCAPED-JSON-SECRET",
    encodedTab: "ENCODED-TAB-SECRET",
    escapedTab: "ESCAPED-TAB-SECRET",
    htmlJson: "HTML-JSON-SECRET",
    htmlEquals: "HTML-EQUALS-SECRET",
    userinfoTail: "RAW/USERINFO-SECRET",
    signedTail: "RAW1&RAW2-SIGNED-SECRET",
    shortBasic: "YTo=",
    azurePat: "AZURE-DEVOPS-PAT-SECRET",
    marketplacePat: "MARKETPLACE-PAT-SECRET",
    apiKeyLabel: "API-KEY-LABEL-SECRET",
    accountKeyLabel: "ACCOUNT-KEY-LABEL-SECRET",
    privateKeyLabel: "PRIVATE-KEY-LABEL-SECRET",
    signingKeyLabel: "SIGNING-KEY-LABEL-SECRET",
    accessKeyLabel: "ACCESS-KEY-LABEL-SECRET",
    accessKeyIdLabel: "ACCESS-KEY-ID-LABEL-SECRET",
    awsAccessKeyIdLabel: "AWS-ACCESS-KEY-ID-LABEL-SECRET",
    encodedKeyLabel: "ENCODED-KEY-LABEL-SECRET",
    escapedKeyLabel: "ESCAPED-KEY-LABEL-SECRET",
    htmlKeyLabel: "HTML-KEY-LABEL-SECRET"
  };
  const redacted = redactEditorAcceptanceText(
    [
      `Basic ${secrets.basic}`,
      `AWS_SECRET_ACCESS_KEY ${secrets.aws}`,
      `client_secret ${secrets.client}`,
      `OVSX_PAT=${secrets.pat}`,
      `--pat ${secrets.cliPat}`,
      `token ${secrets.bareToken}`,
      `%22password%22%3A%22${secrets.encodedJson}%22`,
      String.raw`{\"password\":\"${secrets.escapedJson}\"}`,
      `--token%09${secrets.encodedTab}`,
      String.raw`--token\t${secrets.escapedTab}`,
      `&quot;password&quot;&#58;&quot;${secrets.htmlJson}&quot;`,
      `password&#61;${secrets.htmlEquals}`,
      `https://user:${encodeURIComponent(secrets.userinfoTail)}@example.invalid`,
      `https://example.invalid/?sig=${encodeURIComponent(secrets.signedTail)}`,
      `Basic ${secrets.shortBasic}`,
      `AZURE_DEVOPS_EXT_PAT=${secrets.azurePat}`,
      `MARKETPLACE_PAT ${secrets.marketplacePat}`,
      `API Key: ${secrets.apiKeyLabel}`,
      `Account Key = ${secrets.accountKeyLabel}`,
      `Private Key ${secrets.privateKeyLabel}`,
      `Signing Key:\t${secrets.signingKeyLabel}`,
      `Access Key: ${secrets.accessKeyLabel}`,
      `Access Key ID = ${secrets.accessKeyIdLabel}`,
      `AWS Access Key ID: ${secrets.awsAccessKeyIdLabel}`,
      `%22API%20Key%22%3A%22${secrets.encodedKeyLabel}%22`,
      String.raw`{\"Access\u0020Key\u0020ID\":\"${secrets.escapedKeyLabel}\"}`,
      `&quot;Account&#32;Key&quot;&#58;&quot;${secrets.htmlKeyLabel}&quot;`
    ].join("\n")
  );

  assert.equal(typeof redacted, "string");
  for (const secret of Object.values(secrets)) assert.equal(redacted.includes(secret), false);
  assert.match(redacted, /Basic <redacted>/u);
  assert.match(redacted, /OVSX_PAT=<redacted>/u);
  assert.match(redacted, /--pat <redacted>/u);
  assert.match(redacted, /"password":"<redacted>"/u);
  assert.match(redacted, /--token\s+<redacted>/u);
});

test("human-readable credential fields redact complete values across labels and connectors", () => {
  const secret = "RAW_CREDENTIAL_SENTINEL";
  const second = "RAW_SECOND_SENTINEL";
  const cases = [
    `API${" ".repeat(9)}Key: ${secret}`,
    `API${" ".repeat(4_096)}Key: ${secret}`,
    `api.key=${secret}`,
    `account.key: ${secret}`,
    `private.key=${secret}`,
    `access.key.id=${secret}`,
    `signing.key: ${secret}`,
    `passphrase: ${secret}`,
    `ssh_passphrase=${secret}`,
    `connection string: ${secret}`,
    `session key: ${secret}`,
    `encryption key: ${secret}`,
    `Pwd=${secret}`,
    `secret key: ${secret}`,
    `client secret value: ${secret}`,
    `api key value: ${secret}`,
    `access token value: ${secret}`,
    `password value: ${secret}`,
    `credential value: ${secret}`,
    `auth token value: ${secret}`,
    `private key value: ${secret}`,
    `signing key value: ${secret}`,
    `password is: ${secret}`,
    `password is ${secret}`,
    `token is: ${secret}`,
    `token is ${secret}`,
    `API key is: ${secret}`,
    `the password is ${secret}`,
    `password => ${secret}`,
    `password -> ${secret}`,
    `password :: ${secret}`,
    `token := ${secret}`,
    `API key => ${secret}`,
    `password: ${secret} ${second}`,
    `token = ${secret} ${second}`,
    `%22Connection%20String%22%3A%22${secret}%22`,
    String.raw`{\"Session\u0020Key\":\"${secret}\"}`,
    `&quot;Encryption&#32;Key&quot;&#58;&quot;${secret}&quot;`,
    `shared access signature: ${secret}`,
    `sas token: ${secret}`,
    `<redacted password>: ${secret}`,
    `<redacted-password>: ${secret}`,
    `<redacted api key>: ${secret}`,
    `prefix <redacted access token> = ${secret}`,
    `passwords: ${secret}, ${second}`
  ];

  for (const input of cases) {
    const redacted = redactEditorAcceptanceText(input);
    assert.equal(typeof redacted, "string", input.slice(0, 80));
    assert.doesNotMatch(redacted, new RegExp(secret, "u"), input.slice(0, 80));
    assert.doesNotMatch(redacted, new RegExp(second, "u"), input.slice(0, 80));
    assert.match(redacted, /<redacted>/u, input.slice(0, 80));
  }
});

test("ambiguous multiline credential values fail closed", () => {
  const secret = "ZXQOPAQUE987654321";
  for (const input of [
    `password: |\n  ${secret}`,
    `password: >\n  ${secret}`,
    `api_key: |-\n  ${secret}`,
    `connection string: >-\n  ${secret}`,
    `password:\n  FIRST\n  ${secret}`,
    `tokens: [\n  ${secret}\n]`,
    `password: "unterminated\n${secret}`,
    `--token\n${secret}`,
    `OVSX_PAT\r\n${secret}`,
    `{"tokens":["${secret}","SECOND"]}`,
    `{"passwords":["${secret}","SECOND"]}`,
    `{"apiKeys":["${secret}","SECOND"]}`,
    `{'credentials':['${secret}','SECOND']}`,
    `tokens: [${secret}, SECOND]`
  ]) {
    assert.equal(redactEditorAcceptanceText(input), undefined, input);
  }
});

test("ANSI and encoded terminal controls fail closed before credential matching", () => {
  assert.equal(redactEditorAcceptanceText("password\u001b[31m=RAW-ANSI-SECRET"), undefined);
  assert.equal(redactEditorAcceptanceText("--token\\u001b[0m RAW-ENCODED-ANSI-SECRET"), undefined);
  assert.equal(redactEditorAcceptanceText("--token%1b%5b31m RAW-PERCENT-ANSI-SECRET"), undefined);
  assert.equal(redactEditorAcceptanceText("password\u009b31m=RAW-C1-ANSI-SECRET"), undefined);
  assert.equal(redactEditorAcceptanceText("--token\\u009b0m RAW-ENCODED-C1-ANSI-SECRET"), undefined);
  assert.equal(redactEditorAcceptanceText("--token%C2%9B0m RAW-PERCENT-C1-ANSI-SECRET"), undefined);
  assert.equal(redactEditorAcceptanceText("password\\e[31m=RAW-ESC-E-ANSI-SECRET"), undefined);
  assert.equal(redactEditorAcceptanceText("password\\033[31m=RAW-OCTAL-ANSI-SECRET"), undefined);
});

test("Unicode format controls and encoded variants fail closed", () => {
  const secret = "ZXQOPAQUE987654321";
  for (const input of [
    `pass\u200Bword: ${secret}`,
    `api\u2060key: ${secret}`,
    `pass\u202Eword: ${secret}`,
    `private\u00ADkey: ${secret}`,
    `pass\\u200Bword: ${secret}`,
    `api% E2% 81% A0key: ${secret}`.replaceAll(" ", ""),
    `private&#xAD;key: ${secret}`,
    `private&shy;key: ${secret}`,
    `pass\\u{e0001}word: ${secret}`,
    `pass\\udb40\\udc01word: ${secret}`,
    `pass\uFE0Fword: ${secret}`
  ]) {
    assert.equal(redactEditorAcceptanceText(input), undefined, input);
  }
});

test("encoded PuTTY, SSH2, and PGP private-key containers fail closed", () => {
  assert.equal(
    redactEditorAcceptanceText("PuTTY-User-Key-File-3%3A ssh-ed25519%0APrivate-Lines%3A 1%0APRIVATE-MATERIAL"),
    undefined
  );
  assert.equal(redactEditorAcceptanceText("---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nPRIVATE-MATERIAL"), undefined);
  assert.equal(redactEditorAcceptanceText("-----BEGIN PGP PRIVATE KEY BLOCK-----\nPRIVATE-MATERIAL"), undefined);
});

test("standard structured private-key containers fail closed without broad d or x matching", () => {
  const opaque = "ZXQ731OPAQUE";
  const xprv = `xprv${"A".repeat(107)}`;
  const tprv = `tprv${"B".repeat(107)}`;
  const paserk = `k4.secret.${"E".repeat(64)}`;
  const privateContainers = [
    JSON.stringify({ kty: "RSA", n: "public-modulus", e: "AQAB", d: opaque }),
    JSON.stringify({ d: opaque, x: "public-coordinate", crv: "Ed25519", kty: "OKP" }),
    String.raw`{\u0022\u006bty\u0022:\u0022EC\u0022,\u0022\u0064\u0022:\u0022${opaque}\u0022}`,
    `<RSAKeyValue><Modulus>PUBLIC</Modulus><Exponent>AQAB</Exponent><D>${opaque}</D></RSAKeyValue>`,
    `<ds:RSAKeyValue><ds:P>${opaque}</ds:P><ds:Exponent>AQAB</ds:Exponent></ds:RSAKeyValue>`,
    `<DSAKeyValue><P>PUBLIC</P><Q>PUBLIC</Q><G>PUBLIC</G><Y>PUBLIC</Y><X>${opaque}</X></DSAKeyValue>`,
    ["untrusted comment: minisign encrypted secret key", "RWRTQ0FOTkVEX0tFWQ=="].join("\n"),
    ["untrusted comment: minisign encrypted secret key", "RWRTQ0FOTkVEX0tFWQ=="].join("\r\n"),
    ["untrusted comment: signify secret key", "RWRCSUdOSUZZX0tFWQ=="].join("\n"),
    `client-key-data: ${opaque}`,
    JSON.stringify({ Exponent: "AQAB", Q: opaque, Modulus: "PUBLIC" }),
    JSON.stringify({ Modulus: "PUBLIC", D: opaque, Exponent: "AQAB" }),
    JSON.stringify({ Y: "PUBLIC", G: "PUBLIC", X: opaque, Q: "PUBLIC", P: "PUBLIC" }),
    JSON.stringify({ Q: { X: "PUBLIC-X", Y: "PUBLIC-Y" }, D: opaque, Curve: { Oid: "1.2.840.10045.3.1.7" } }),
    xprv,
    tprv,
    String.raw`\u0078prv${"C".repeat(107)}`,
    paserk,
    JSON.stringify({ key: paserk }),
    String.raw`{"key":"\u006b4.secret.${"F".repeat(64)}"}`
  ];
  for (const input of privateContainers) assert.equal(redactEditorAcceptanceText(input), undefined, input.slice(0, 80));

  const encodedXml = encodeURIComponent(
    encodeURIComponent(`<RSAKeyValue><Exponent>AQAB</Exponent><InverseQ>${opaque}</InverseQ></RSAKeyValue>`)
  );
  const encodedHeader = encodeURIComponent(
    encodeURIComponent(`untrusted comment: minisign encrypted secret key\nRWRTQ0FOTkVEX0tFWQ==`)
  );
  const encodedClientKey = encodeURIComponent(encodeURIComponent(`client_key_data=${opaque}`));
  assert.equal(redactEditorAcceptanceText(encodedXml), undefined);
  assert.equal(redactEditorAcceptanceText(encodedHeader), undefined);
  assert.equal(redactEditorAcceptanceText(encodedClientKey), undefined);

  const publicAndOrdinaryValues = [
    JSON.stringify({ d: opaque, x: opaque }),
    JSON.stringify({ kty: "RSA", n: "public-modulus", e: "AQAB" }),
    JSON.stringify({ kty: "RSA", metadata: { d: opaque } }),
    JSON.stringify({ Modulus: "PUBLIC", Exponent: "AQAB", Description: opaque }),
    JSON.stringify({ Modulus: "PUBLIC", Exponent: "AQAB", metadata: { D: opaque } }),
    JSON.stringify({ P: "PUBLIC", Q: "PUBLIC", G: "PUBLIC", Y: "PUBLIC" }),
    JSON.stringify({ Curve: { Oid: "1.2.840.10045.3.1.7" }, Q: { X: "PUBLIC-X", Y: "PUBLIC-Y" } }),
    JSON.stringify({ Curve: "ordinary", Q: "ordinary", metadata: { D: opaque } }),
    `<RSAKeyValue><Modulus>PUBLIC</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>`,
    `<DSAKeyValue><P>PUBLIC</P><Q>PUBLIC</Q><G>PUBLIC</G><Y>PUBLIC</Y></DSAKeyValue>`,
    `<D>${opaque}</D><X>${opaque}</X>`,
    "untrusted comment: minisign public key",
    `xpub${"D".repeat(107)}`,
    `k4.public.${"G".repeat(64)}`
  ];
  for (const input of publicAndOrdinaryValues) assert.equal(redactEditorAcceptanceText(input), input);
});

test("plist and XML secret fields with following value containers fail closed", () => {
  const opaque = "ZXQ731OPAQUE";
  const cases = [
    `<key>Password</key>\n<string>${opaque}</string>`,
    `<key>PrivateKey</key>\n<data>${opaque}</data>`,
    `<key>client-key-data</key><!-- retained formatting comment -->\n<data>${opaque}</data>`,
    `<property name="password">\n  <value>${opaque}</value>\n</property>`,
    `<entry key='OVSX_PAT'><string>${opaque}</string></entry>`,
    encodeURIComponent(encodeURIComponent(`<key>SigningKey</key>\n<data>${opaque}</data>`))
  ];
  for (const input of cases) assert.equal(redactEditorAcceptanceText(input), undefined, input.slice(0, 80));

  const ordinary = `<key>DisplayName</key>\n<string>${opaque}</string>`;
  assert.equal(redactEditorAcceptanceText(ordinary), ordinary);
});

test("AGE secret-key identities fail closed even inside quoted values", () => {
  const identity = `AGE-SECRET-KEY-1${"Q".repeat(58)}`;
  for (const input of [
    identity,
    JSON.stringify({ identity }),
    `identity: "${identity}"`,
    String.raw`{"identity":"\u0041GE-SECRET-KEY-1${"Q".repeat(58)}"}`
  ]) {
    assert.equal(redactEditorAcceptanceText(input), undefined, input);
  }
});

test("known Windows paths are replaced before escape normalization", () => {
  const hostPath = String.raw`C:\tool\x64\Users\Alice`;
  const redacted = redactEditorAcceptanceText(`profile=${hostPath}`, [[hostPath, "<host>"]]);
  assert.equal(redacted, "profile=<host>");
});

test("braced Unicode escapes with leading zeros cannot hide private-key labels", () => {
  const encoded = [..."-----BEGIN OPENSSH PRIVATE KEY-----"]
    .map((character) => `\\u{${character.codePointAt(0).toString(16).padStart(4, "0")}}`)
    .join("");
  assert.equal(redactEditorAcceptanceText(`${encoded}\nPRIVATE-BODY`), undefined);
});

test("security-escape normalization remains linear on long unmatched backslash runs", () => {
  const input = "\\".repeat(2 * 1024 * 1024);
  const startedAt = Date.now();
  assert.equal(redactEditorAcceptanceText(input), input);
  assert.ok(Date.now() - startedAt < 2_000, "A bounded 2 MiB diagnostic must normalize within two seconds.");
});

test("text redaction covers localhost and percent-hex variants without folding POSIX path casing", () => {
  const profile = "/home/Alice Smith/é/Profile";
  const text = [
    "FILE://LOCALHOST/home/Alice%20Smith/%c3%a9/Profile",
    "file:///home/Alice%20Smith/%C3%a9/Profile",
    "/HOME/Alice Smith/é/Profile"
  ].join("\n");

  const redacted = redactEditorAcceptanceText(text, [[profile, "<profile>"]]);
  assert.equal(typeof redacted, "string");
  assert.equal((redacted.match(/<profile>/gu) ?? []).length, 2);
  assert.match(redacted, /\/HOME\/Alice Smith\/é\/Profile/u);
  assert.equal(redacted.includes("FILE://LOCALHOST/home/Alice%20Smith/%c3%a9/Profile"), false);
});

test("evidence collection enforces canonical profile, result, and retention containment", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-containment-"));
  const temporaryRoot = join(directory, "editor-temp");
  const profile = join(temporaryRoot, "profile");
  const resultPath = join(profile, "verify-result.json");
  const outsideProfile = join(directory, "outside-profile");
  const outsideResult = join(directory, "outside-result.json");
  await mkdir(profile, { recursive: true });
  await mkdir(outsideProfile, { recursive: true });
  await writeFile(resultPath, "{}\n");
  await writeFile(outsideResult, "{}\n");

  const options = {
    evidenceRoot: join(directory, "evidence"),
    temporaryRoot,
    profile,
    editor: { key: "vscode", name: "VS Code", version: "1.129.0" },
    phase: "verify",
    error: new Error("failed"),
    hostHome: process.env.HOME,
    resultPath
  };

  try {
    assert.throws(
      () => retainEditorAcceptanceEvidence({ ...options, profile: outsideProfile, resultPath: outsideResult }),
      /acceptance profile must be inside/u
    );
    assert.throws(
      () => retainEditorAcceptanceEvidence({ ...options, evidenceRoot: join(temporaryRoot, "evidence") }),
      /evidence must live outside/u
    );
    assert.throws(
      () => retainEditorAcceptanceEvidence({ ...options, evidenceRoot: temporaryRoot }),
      /evidence must live outside/u
    );
    assert.throws(
      () => retainEditorAcceptanceEvidence({ ...options, resultPath: outsideResult }),
      /acceptance result must be inside/u
    );
    assert.throws(
      () =>
        retainEditorAcceptanceEvidence({
          ...options,
          resultPaths: { verify: resultPath, seed: outsideResult }
        }),
      /acceptance result for seed must be inside/u
    );
    assert.throws(
      () => retainEditorAcceptanceEvidence({ ...options, attempt: "../../escape" }),
      /attempt must be a positive safe integer/u
    );
    assert.throws(
      () => retainEditorAcceptanceEvidence({ ...options, hostHome: "relative/home" }),
      /host home must be an absolute path/u
    );
    assert.throws(
      () => retainEditorAcceptanceEvidence({ ...options, hostHomes: [resolve(directory), "relative/home"] }),
      /host home must be an absolute path/u
    );
    assert.throws(
      () => retainEditorAcceptanceEvidence({ ...options, evidenceMode: "unknown" }),
      /evidence mode must be either/u
    );
    assert.throws(
      () => retainEditorAcceptanceEvidence({ ...options, evidenceMode: "metadata-only" }),
      /requires a non-empty reason/u
    );

    if (process.platform !== "win32") {
      const escapedProfile = join(directory, "escaped-profile");
      const linkedProfile = join(temporaryRoot, "linked-profile");
      await mkdir(escapedProfile);
      await symlink(escapedProfile, linkedProfile, "dir");
      assert.throws(
        () =>
          retainEditorAcceptanceEvidence({
            ...options,
            profile: linkedProfile,
            resultPath: join(linkedProfile, "verify-result.json")
          }),
        /acceptance profile must be inside/u
      );
    } else {
      context.diagnostic("Canonical symlink escape coverage is POSIX-only in this test environment.");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("metadata-only evidence redacts diagnostics without inspecting the live profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-metadata-only-"));
  const temporaryRoot = join(directory, "editor-temp");
  const profile = join(temporaryRoot, "profile");
  const resultPath = join(profile, "results", "verify-result.json");
  const logRoot = join(profile, "user-data", "logs", "hostile", "window1");
  const evidenceRoot = join(directory, "evidence");
  const resultSecret = "LIVE-RESULT-SECRET-MUST-NOT-BE-READ";
  const logSecret = "LIVE-LOG-SECRET-MUST-NOT-BE-READ";
  const diagnosticSecret = "IN-MEMORY-DIAGNOSTIC-SECRET";
  const reasonSecret = "IN-MEMORY-REASON-SECRET";

  await mkdir(join(resultPath, ".."), { recursive: true });
  await mkdir(logRoot, { recursive: true });
  await writeFile(resultPath, `-----BEGIN OPENSSH PRIVATE KEY-----\n${resultSecret}\n`);
  await writeFile(`${resultPath}.progress`, `${resultSecret}\n`);
  await writeFile(join(logRoot, "renderer.log"), `${logSecret}\n`);
  if (process.platform !== "win32") {
    const outsideLog = join(directory, "outside-renderer.log");
    await writeFile(outsideLog, `${logSecret}\n`);
    await symlink(outsideLog, join(logRoot, "notebook.rendering.log"));
  }

  const error = new Error(`ownership failed password=${diagnosticSecret} profile=${profile}`);
  error.kind = "cleanup-failure";
  error.details = {
    credential: diagnosticSecret,
    progress: `token=${diagnosticSecret} result=${resultPath}`,
    exitCode: 125
  };

  const inspected = [];
  const originals = new Map();
  const pathFunctions = ["existsSync", "lstatSync", "openSync", "opendirSync", "realpathSync", "statSync"];
  const isLiveProfilePath = (value) => {
    if (typeof value !== "string") return false;
    const candidate = resolve(value);
    const nested = relative(profile, candidate);
    return candidate === profile || (nested !== "" && nested !== ".." && !nested.startsWith(`..${sep}`));
  };
  for (const name of pathFunctions) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = (...args) => {
      if (isLiveProfilePath(args[0])) {
        inspected.push(`${name}:${args[0]}`);
        throw new Error(`metadata-only evidence inspected ${args[0]}`);
      }
      return original(...args);
    };
  }
  for (const name of ["fstatSync", "readSync"]) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = () => {
      inspected.push(name);
      throw new Error(`metadata-only evidence called ${name}`);
    };
  }
  syncBuiltinESMExports();

  let target;
  try {
    target = retainEditorAcceptanceEvidence({
      evidenceRoot,
      temporaryRoot,
      profile,
      editor: { key: "vscode", name: "VS Code", version: "1.129.0" },
      phase: "cleanup",
      error,
      hostHome: process.env.HOME,
      resultPath,
      evidenceMode: "metadata-only",
      evidenceReason: `process-tree-ownership-unverified token=${reasonSecret}`
    });
  } finally {
    for (const [name, original] of originals) fs[name] = original;
    syncBuiltinESMExports();
  }

  try {
    assert.deepEqual(inspected, []);
    assert.deepEqual(await readdir(target), ["failure.json"]);
    const rawFailure = await readFile(join(target, "failure.json"), "utf8");
    const failure = JSON.parse(rawFailure);
    assert.equal(failure.evidenceMode, "metadata-only");
    assert.equal(failure.evidenceReason, "process-tree-ownership-unverified token=<redacted>");
    assert.deepEqual(failure.copiedFiles, []);
    assert.deepEqual(failure.skippedFiles, []);
    assert.equal(rawFailure.includes(profile), false);
    assert.equal(rawFailure.includes(resultSecret), false);
    assert.equal(rawFailure.includes(logSecret), false);
    assert.equal(rawFailure.includes(diagnosticSecret), false);
    assert.equal(rawFailure.includes(reasonSecret), false);
    await assert.rejects(lstat(join(target, "profile-manifest.json")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure evidence retains only sanitized allowlisted text and survives profile deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-retain-"));
  const temporaryRoot = join(directory, "editor-temp");
  const profile = join(temporaryRoot, "profile");
  const evidenceRoot = join(directory, "retained-evidence");
  const resultPath = join(profile, "results", "verify-result.json");
  const splitResultPath = join(profile, "token=", "split-path-secret-that-must-not-survive", "split-result.json");
  const progressPath = `${resultPath}.progress`;
  const logRoot = join(profile, "user-data", "logs");
  const originalHostHome = join(directory, "original-host-home");
  const alternateHostHome = join(directory, "alternate-host-home");
  const outsideSymlinkTarget = join(directory, "outside-renderer.log");
  const githubToken = `ghp_${"A".repeat(24)}`;
  const apiKey = "api-key-value-that-must-not-survive";
  const password = "url-password-that-must-not-survive";
  const pathSecret = "path-secret-that-must-not-survive";
  const skippedPathSecret = "skipped-path-secret-that-must-not-survive";
  const splitPathSecret = "split-path-secret-that-must-not-survive";
  const encodedJsonSecret = "encoded-json-secret-that-must-not-survive";
  const escapedJsonSecret = "escaped-json-secret-that-must-not-survive";
  const basicSecret = "dXNlcjpyZXRhaW5lZC1ldmlkZW5jZS1zZWNyZXQ=";
  const whitespaceSecret = "whitespace-secret-that-must-not-survive";
  const patSecret = "ovsx-pat-secret-that-must-not-survive";
  const escapedTabSecret = "escaped-tab-secret-that-must-not-survive";
  const htmlSecret = "html-secret-that-must-not-survive";
  const encodedUserinfoSecret = "encoded/userinfo-secret-that-must-not-survive";
  const encodedSignedSecret = "encoded&signed-secret-that-must-not-survive";
  const mainLogSession = `session-token=${pathSecret}`;
  const linkedLogSession = `linked-token=${skippedPathSecret}`;
  const disallowedContent = "DISALLOWED-TELEMETRY-CONTENT";
  const settingsContent = "USER-SETTINGS-MUST-NOT-BE-COPIED";
  const symlinkContent = "SYMLINK-TARGET-MUST-NOT-BE-COPIED";
  const oversizedLog = `HEAD-MUST-BE-TRUNCATED\n${"€".repeat(180_000)}TAIL-IS-RETAINED`;

  await mkdir(join(resultPath, ".."), { recursive: true });
  await mkdir(join(logRoot, mainLogSession), { recursive: true });
  await mkdir(join(logRoot, "private"), { recursive: true });
  await mkdir(join(logRoot, "escaped-private"), { recursive: true });
  await mkdir(join(logRoot, "nested-private"), { recursive: true });
  await mkdir(join(logRoot, "binary", "window1", "exthost"), { recursive: true });
  await mkdir(join(logRoot, "invalid", "window1", "exthost"), { recursive: true });
  await mkdir(join(logRoot, "boundary-invalid", "window1"), { recursive: true });
  await mkdir(join(logRoot, linkedLogSession, "window1"), { recursive: true });
  await mkdir(join(logRoot, "safe", "window1"), { recursive: true });
  await mkdir(join(logRoot, "output", "window1", "exthost", "output_logging_20260717"), {
    recursive: true
  });
  await mkdir(join(logRoot, "rogue", "extension"), { recursive: true });
  await mkdir(join(profile, "user-data", "User"), { recursive: true });

  const sensitiveText = [
    `profile=${profile}`,
    `temporary=${temporaryRoot}`,
    `repository=${process.cwd()}`,
    `home=${originalHostHome}`,
    `alternateHome=${alternateHostHome}`,
    "Authorization: Bearer authorization-value",
    `Basic ${basicSecret}`,
    `OPENAI_API_KEY=${apiKey}`,
    "OPEN_WRANGLER_TOKEN=generic-token-value",
    `AWS_SECRET_ACCESS_KEY ${whitespaceSecret}`,
    `OVSX_PAT=${patSecret}`,
    `%22password%22%3A%22${encodedJsonSecret}%22`,
    String.raw`{\"password\":\"${escapedJsonSecret}\"}`,
    String.raw`--token\t${escapedTabSecret}`,
    `&quot;password&quot;&#58;&quot;${htmlSecret}&quot;`,
    `https://user:${encodeURIComponent(encodedUserinfoSecret)}@example.invalid`,
    `https://example.invalid/?sig=${encodeURIComponent(encodedSignedSecret)}`,
    githubToken,
    `https://diagnostic-user:${password}@example.test/private`
  ].join("\n");
  await writeFile(resultPath, `${sensitiveText}\n`);
  await mkdir(join(splitResultPath, ".."), { recursive: true });
  await writeFile(splitResultPath, Buffer.from("password\u001b[31m=ANSI-SECRET\0", "utf8"));
  await writeFile(progressPath, `verify:notebook:${profile} token=progress-secret\n`);
  await writeFile(join(logRoot, mainLogSession, "main.log"), oversizedLog);
  await writeFile(
    join(logRoot, "private", "sharedprocess.log"),
    `-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material\n${"x".repeat(LOG_FILE_LIMIT)}\n`
  );
  await writeFile(
    join(logRoot, "escaped-private", "sharedprocess.log"),
    `${String.raw`-----BEGIN\u0020OPENSSH\u0020PRIVATE\u0020KEY-----`}\nescaped-private-material\n${"y".repeat(LOG_FILE_LIMIT)}\n`
  );
  await writeFile(
    join(logRoot, "nested-private", "sharedprocess.log"),
    `${String.raw`-----BEGIN\u005cu0020OPENSSH\u005cu0020PRIVATE\u005cu0020KEY-----`}\nnested-private-material\n${"z".repeat(LOG_FILE_LIMIT)}\n`
  );
  await writeFile(join(logRoot, "binary", "window1", "exthost", "exthost.log"), Buffer.from("binary\0payload", "utf8"));
  await writeFile(join(logRoot, "invalid", "window1", "exthost", "exthost.log"), Buffer.from([0xff, 0xfe, 0xfd]));
  const invalidBoundaryLog = Buffer.alloc(LOG_FILE_LIMIT + 1, 0x61);
  invalidBoundaryLog[1] = 0x80;
  await writeFile(join(logRoot, "boundary-invalid", "window1", "renderer.log"), invalidBoundaryLog);
  await writeFile(join(logRoot, "safe", "window1", "notebook.rendering.log"), `${sensitiveText}\n`);
  await writeFile(
    join(logRoot, "output", "window1", "exthost", "output_logging_20260717", "1-Open Wrangler.log"),
    "Open Wrangler output channel remained responsive.\n"
  );
  await writeFile(join(logRoot, "rogue", "extension", "main.log"), "ROGUE-MAIN-MUST-NOT-BE-COPIED\n");
  await writeFile(join(logRoot, mainLogSession, "telemetry.log"), disallowedContent);
  await writeFile(join(profile, "user-data", "User", "settings.json"), settingsContent);
  await writeFile(outsideSymlinkTarget, symlinkContent);
  await symlink(outsideSymlinkTarget, join(logRoot, linkedLogSession, "window1", "renderer.log"));

  const error = new Error(`Verification failed in ${profile}: Authorization=message-secret`);
  error.kind = "outer-timeout";
  error.details = {
    elapsedMs: 180_000,
    exitCode: null,
    signal: "SIGTERM",
    timeoutKind: "inactivity",
    progress: `verify:notebook:${profile} token=detail-secret`,
    diagnostic: `${temporaryRoot} ${githubToken}`,
    apiKey: "structured-secret-that-must-not-survive"
  };

  let retainedTarget;
  try {
    retainedTarget = retainEditorAcceptanceEvidence({
      evidenceRoot,
      temporaryRoot,
      profile,
      editor: { key: "vscode", name: "VS Code", version: "1.129.0-insider" },
      phase: "verify",
      error,
      hostHomes: [originalHostHome, alternateHostHome],
      resultPath,
      resultPaths: { verify: resultPath, split: splitResultPath }
    });
    assert.equal(relative(evidenceRoot, retainedTarget).startsWith(".."), false);

    await rm(temporaryRoot, { recursive: true, force: true });
    assert.equal((await stat(retainedTarget)).isDirectory(), true);

    const allEvidence = await readEvidenceTree(retainedTarget);
    const allEvidenceNames = await readEvidenceNames(retainedTarget);
    for (const secret of [
      profile,
      temporaryRoot,
      process.cwd(),
      originalHostHome,
      alternateHostHome,
      "authorization-value",
      apiKey,
      "generic-token-value",
      githubToken,
      password,
      pathSecret,
      skippedPathSecret,
      splitPathSecret,
      encodedJsonSecret,
      escapedJsonSecret,
      basicSecret,
      whitespaceSecret,
      patSecret,
      escapedTabSecret,
      htmlSecret,
      encodedUserinfoSecret,
      encodedSignedSecret,
      "ANSI-SECRET",
      "progress-secret",
      "detail-secret",
      "structured-secret-that-must-not-survive",
      "message-secret",
      disallowedContent,
      "ROGUE-MAIN-MUST-NOT-BE-COPIED",
      settingsContent,
      symlinkContent,
      "private-material"
    ].filter(Boolean)) {
      assert.equal(allEvidence.includes(secret), false, `Retained evidence leaked ${secret}.`);
      assert.equal(allEvidenceNames.includes(secret), false, `Retained evidence filename leaked ${secret}.`);
    }
    assert.match(allEvidence, /<profile>/u);
    assert.match(allEvidence, /<editor-temp>/u);
    assert.match(allEvidence, /<repository>/u);
    assert.match(allEvidence, /<host-home>/u);
    assert.match(allEvidence, /Authorization: <redacted>/u);
    assert.match(allEvidence, /OPENAI_API_KEY=<redacted>/u);
    assert.match(allEvidence, /OPEN_WRANGLER_TOKEN=<redacted>/u);
    assert.match(allEvidence, /<redacted>/u);
    assert.match(allEvidence, /https:\/\/<redacted>@example\.test\/private/u);

    const retainedLogNames = await readdir(join(retainedTarget, "logs"));
    const retainedMainName = retainedLogNames.find((name) => name.endsWith("-main.log"));
    assert.equal(typeof retainedMainName, "string");
    const retainedMainPath = join(retainedTarget, "logs", retainedMainName);
    const retainedMain = await readFile(retainedMainPath, "utf8");
    assert.equal(retainedMain.includes("HEAD-MUST-BE-TRUNCATED"), false);
    assert.equal(retainedMain.includes("TAIL-IS-RETAINED"), true);
    assert.equal(retainedMain.includes("�"), false, "A mid-codepoint tail must remain valid UTF-8.");
    assert.ok((await stat(retainedMainPath)).size <= LOG_FILE_LIMIT);

    const manifest = JSON.parse(await readFile(join(retainedTarget, "profile-manifest.json"), "utf8"));
    const manifestByPath = new Map(manifest.map((entry) => [entry.path, entry]));
    const retainedMainManifest = manifest.find(
      (entry) =>
        entry.type === "file" && entry.evidence?.status === "retained" && entry.evidence.target.endsWith("-main.log")
    );
    assert.deepEqual(retainedMainManifest.evidence, {
      status: "retained",
      target: `logs/${retainedMainName}`,
      sourceBytes: Buffer.byteLength(oversizedLog),
      retainedBytes: (await stat(retainedMainPath)).size,
      truncated: true
    });
    assert.equal(manifestByPath.get("user-data/logs/private/sharedprocess.log").evidence.reason, "private-key");
    assert.equal(manifestByPath.get("user-data/logs/escaped-private/sharedprocess.log").evidence.reason, "private-key");
    assert.equal(manifestByPath.get("user-data/logs/nested-private/sharedprocess.log").evidence.reason, "private-key");
    assert.equal(manifestByPath.get("user-data/logs/binary/window1/exthost/exthost.log").evidence.reason, "binary");
    assert.equal(manifestByPath.get("user-data/logs/invalid/window1/exthost/exthost.log").evidence.reason, "not-utf8");
    assert.equal(
      manifestByPath.get("user-data/logs/boundary-invalid/window1/renderer.log").evidence.reason,
      "not-utf8"
    );
    assert.equal(
      manifest.find((entry) => entry.type === "symlink" && entry.evidence?.reason === "not-regular").evidence.reason,
      "not-regular"
    );
    assert.equal(
      manifest.some(
        (entry) => entry.type === "file" && entry.size === Buffer.byteLength(disallowedContent) && !entry.evidence
      ),
      true
    );
    assert.equal(manifestByPath.get("user-data/logs/rogue/extension/main.log").evidence, undefined);
    assert.equal(manifestByPath.get("user-data/User/settings.json").evidence, undefined);

    const failure = JSON.parse(await readFile(join(retainedTarget, "failure.json"), "utf8"));
    assert.equal(failure.classification, "outer-timeout");
    assert.equal(failure.resultPath, "<profile>/results/verify-result.json");
    assert.equal(failure.lastProgress.includes("<profile>"), true);
    assert.equal(Object.values(failure.details).includes("<redacted>"), true);
    assert.deepEqual(
      new Map(failure.skippedFiles.map((entry) => [entry.path, entry.reason])),
      new Map([
        ["user-data/logs/binary/window1/exthost/exthost.log", "binary"],
        ["user-data/logs/boundary-invalid/window1/renderer.log", "not-utf8"],
        ["user-data/logs/escaped-private/sharedprocess.log", "private-key"],
        ["user-data/logs/invalid/window1/exthost/exthost.log", "not-utf8"],
        ["user-data/logs/linked-token=<redacted>", "not-regular"],
        ["token=<redacted>", "binary"],
        ["user-data/logs/nested-private/sharedprocess.log", "private-key"],
        ["user-data/logs/private/sharedprocess.log", "private-key"]
      ])
    );
    assert.equal(
      failure.copiedFiles.some((path) => path.endsWith("-notebook-rendering.log")),
      true
    );
    assert.equal(
      failure.copiedFiles.some((path) => path.endsWith("-open-wrangler-output.log")),
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure metadata has hard byte, depth, entry, and string limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-failure-bounds-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const deep = {};
    let cursor = deep;
    for (let depth = 0; depth < 32; depth += 1) {
      cursor.child = {};
      cursor = cursor.child;
    }
    const details = {
      deep,
      quotedApiKey: "structured-bound-secret",
      long: "long-value".repeat(250_000)
    };
    details.circular = details;
    for (let index = 0; index < 2_000; index += 1) details[`field-${index}`] = `value-${index}`;

    const error = new Error(`message-password=message-bound-secret ${"m".repeat(1_000_000)}`);
    error.kind = "runner-failure";
    error.details = details;
    const target = retainEditorAcceptanceEvidence({ ...fixture.options, error });
    const failurePath = join(target, "failure.json");
    const rawFailure = await readFile(failurePath, "utf8");
    const failure = JSON.parse(rawFailure);

    assert.ok((await stat(failurePath)).size <= FAILURE_FILE_LIMIT);
    assert.equal(rawFailure.includes("structured-bound-secret"), false);
    assert.equal(rawFailure.includes("message-bound-secret"), false);
    assert.match(rawFailure, /<truncated-depth>/u);
    assert.match(rawFailure, /<circular>/u);
    assert.match(rawFailure, /<truncated-entry-budget>/u);
    assert.equal(Object.values(failure.details).includes("<redacted>"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure-string bounds never cut security terminators before redaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-diagnostic-boundaries-"));
  const exactLength = (prefix, suffix, length) => {
    assert.ok(prefix.length + suffix.length <= length);
    return `${prefix}${"x".repeat(length - prefix.length - suffix.length)}${suffix}`;
  };
  const maximumBytes = 8 * 1024;
  const formerlyTruncatedLength = maximumBytes * 2 + 1;
  const marker = "<diagnostic-omitted-size-budget>";
  const secrets = [
    "BOUNDED-UINFO-MATERIAL",
    "BOUNDED-SIGVALUE-MATERIAL",
    "BOUNDED-PKEY-MATERIAL",
    "OVERSIZED-UINFO-MATERIAL",
    "OVERSIZED-SIGVALUE-MATERIAL",
    "OVERSIZED-PKEY-MATERIAL"
  ];
  try {
    const fixture = await createEvidenceFixture(directory);
    const error = new Error("boundary diagnostics failed");
    error.details = {
      boundedUserinfo: exactLength("https://BOUNDED-UINFO-MATERIAL:", "@example.test", maximumBytes),
      boundedSignedQuery: exactLength(
        "https://example.test/object?sig=BOUNDED-SIGVALUE-MATERIAL",
        "&safe=1",
        maximumBytes
      ),
      boundedPem: exactLength("-----BEGIN BOUNDED-PKEY-MATERIAL", " PRIVATE KEY-----", maximumBytes),
      oversizedUserinfo: exactLength("https://OVERSIZED-UINFO-MATERIAL:", "@example.test", formerlyTruncatedLength),
      oversizedSignedQuery: exactLength(
        "https://example.test/object?sig=OVERSIZED-SIGVALUE-MATERIAL",
        "&safe=1",
        formerlyTruncatedLength
      ),
      oversizedPem: exactLength("-----BEGIN OVERSIZED-PKEY-MATERIAL", " PRIVATE KEY-----", formerlyTruncatedLength),
      oversizedUtf8: "é".repeat(maximumBytes / 2 + 1)
    };

    const target = retainEditorAcceptanceEvidence({ ...fixture.options, error });
    const rawFailure = await readFile(join(target, "failure.json"), "utf8");
    const failure = JSON.parse(rawFailure);

    for (const secret of secrets) assert.equal(rawFailure.includes(secret), false, secret);
    assert.equal(failure.details.boundedUserinfo, "https://<redacted>@example.test");
    assert.equal(failure.details.boundedSignedQuery, "https://example.test/object?sig=<redacted>&safe=1");
    assert.equal(failure.details.boundedPem, "<redacted-private-key>");
    assert.equal(failure.details.oversizedUserinfo, marker);
    assert.equal(failure.details.oversizedSignedQuery, marker);
    assert.equal(failure.details.oversizedPem, marker);
    assert.equal(failure.details.oversizedUtf8, marker);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retained result and structured failure metadata remove escaped credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-escaped-secrets-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const secrets = {
      resultCredential: "RESULT-CREDENTIAL-MUST-NOT-SURVIVE",
      resultUserinfo: "RESULT-USERINFO-MUST-NOT-SURVIVE",
      resultSignature: "RESULT-SIGNATURE-MUST-NOT-SURVIVE",
      structuredCredential: "STRUCTURED-CREDENTIAL-MUST-NOT-SURVIVE",
      structuredAccessKey: "STRUCTURED-ACCESS-KEY-MUST-NOT-SURVIVE",
      nestedUserinfo: "NESTED-USERINFO-MUST-NOT-SURVIVE",
      nestedCredential: "NESTED-CREDENTIAL-MUST-NOT-SURVIVE",
      azureAccountKey: "AZURE-ACCOUNT-KEY-MUST-NOT-SURVIVE",
      npmAuth: "NPM-AUTH-MUST-NOT-SURVIVE",
      dockerAuth: "DOCKER-AUTH-MUST-NOT-SURVIVE",
      gitlabToken: syntheticCredential("glpat", "-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
      slackToken: syntheticCredential("xox", "b-", "123456789012", "-abcdefghijklmnopqrst")
    };
    await writeFile(
      fixture.options.resultPath,
      [
        String.raw`{"creden\u0074ial":"${secrets.resultCredential}"}`,
        String.raw`{"url":"https:\/\/user:${secrets.resultUserinfo}@example.test/private"}`,
        String.raw`{"url":"https://example.test/?safe=1\u0026sig=${secrets.resultSignature}"}`,
        String.raw`{"creden\u005cu0074ial":"${secrets.nestedCredential}"}`,
        `AccountKey=${secrets.azureAccountKey}`,
        `_auth=${secrets.npmAuth}`,
        `{"auth":"${secrets.dockerAuth}"}`,
        secrets.gitlabToken,
        secrets.slackToken
      ].join("\n")
    );
    const error = new Error("escaped credential evidence failed");
    error.details = {
      credential: secrets.structuredCredential,
      awsAccessKeyId: secrets.structuredAccessKey,
      nested: [String.raw`https:\/\/user:${secrets.nestedUserinfo}@example.test/private`]
    };

    const target = retainEditorAcceptanceEvidence({ ...fixture.options, error });
    const retained = await readEvidenceTree(target);
    for (const secret of Object.values(secrets)) {
      assert.equal(retained.includes(secret), false, `Retained evidence leaked ${secret}.`);
    }
    const failure = JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
    assert.equal(failure.details["<redacted-key>"], "<redacted>");
    assert.equal(failure.details["<redacted-key>-2"], "<redacted>");
    assert.match(retained, /<redacted>/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("structured BigInt diagnostics obey the per-string and final failure caps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-bigint-bound-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const error = new Error("large integer diagnostic");
    const hugeInteger = 10n ** 100_000n;
    error.details = {
      ordinaryInteger: 42n,
      largeInteger: hugeInteger,
      exitCode: hugeInteger,
      signal: -hugeInteger,
      timeoutKind: hugeInteger
    };

    const target = retainEditorAcceptanceEvidence({ ...fixture.options, error });
    const failurePath = join(target, "failure.json");
    const failure = JSON.parse(await readFile(failurePath, "utf8"));
    assert.equal(failure.details.ordinaryInteger, "42");
    assert.equal(failure.details.largeInteger, "<bigint-truncated-1024-digits>");
    assert.equal(failure.exitCode, "<bigint-truncated-1024-digits>");
    assert.equal(failure.signal, "<bigint-truncated-1024-digits>");
    assert.equal(failure.timeoutKind, "<bigint-truncated-1024-digits>");
    assert.ok((await stat(failurePath)).size <= FAILURE_FILE_LIMIT);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evidence reads remain bound to one no-follow descriptor across a path swap", async (context) => {
  if (process.platform !== "linux") {
    context.skip("The deterministic path-swap proof uses Linux /proc descriptor inspection.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-path-swap-"));
  let swapper;
  try {
    const fixture = await createEvidenceFixture(directory);
    const source = fixture.options.resultPath;
    const replacement = `${source}.replacement`;
    const backup = `${source}.original`;
    const replacementSecret = "PATH-SWAP-SECRET-MUST-NOT-SURVIVE";
    await writeFile(source, Buffer.alloc(EVIDENCE_SOURCE_LIMIT, 0x61));
    await writeFile(replacement, `${replacementSecret}\n`);

    const swapScript = `
      import { readdirSync, realpathSync, renameSync } from "node:fs";
      const [pidText, source, replacement, backup] = process.argv.slice(1);
      const descriptorRoot = \`/proc/\${pidText}/fd\`;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      process.stdout.write("ready\\n");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        let descriptors = [];
        try { descriptors = readdirSync(descriptorRoot); } catch {}
        for (const descriptor of descriptors) {
          try {
            if (realpathSync(\`\${descriptorRoot}/\${descriptor}\`) !== source) continue;
            renameSync(source, backup);
            renameSync(replacement, source);
            process.stdout.write("swapped\\n");
            process.exit(0);
          } catch {}
        }
        Atomics.wait(sleeper, 0, 0, 1);
      }
      process.exit(2);
    `;
    swapper = spawn(
      process.execPath,
      ["--input-type=module", "-e", swapScript, String(process.pid), source, replacement, backup],
      {
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const exitPromise = once(swapper, "exit");
    const [ready] = await once(swapper.stdout, "data");
    assert.match(String(ready), /ready/u);

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const [exitCode, signal] = await exitPromise;
    assert.equal(signal, null);
    assert.equal(exitCode, 0);
    const evidence = await readEvidenceTree(target);
    assert.equal(evidence.includes(replacementSecret), false);
    const failure = JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
    assert.equal(
      failure.skippedFiles.some((entry) => entry.reason === "path-race"),
      true
    );
  } finally {
    swapper?.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile traversal stays bound to its contained directory across a symlink swap", async (context) => {
  if (process.platform !== "linux") {
    context.skip("The deterministic directory-descriptor swap proof uses Linux /proc descriptor inspection.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-directory-swap-"));
  let swapper;
  try {
    const fixture = await createEvidenceFixture(directory);
    const source = join(fixture.logRoot, "race-session");
    const backup = `${source}.original`;
    const outside = join(directory, "outside-directory");
    const outsideNameSecret = "OUTSIDE-DIRECTORY-NAME-MUST-NOT-SURVIVE.log";
    const outsideContentSecret = "OUTSIDE-DIRECTORY-CONTENT-MUST-NOT-SURVIVE";
    await mkdir(source);
    await mkdir(outside);
    await writeFile(join(source, "main.log"), "contained log\n");
    await writeFile(join(outside, outsideNameSecret), `${outsideContentSecret}\n`);
    for (let index = 0; index < 1_000; index += 1) {
      await writeFile(join(source, `entry-${String(index).padStart(4, "0")}.txt`), "contained\n");
    }

    const swapScript = `
      import { readdirSync, realpathSync, renameSync, symlinkSync } from "node:fs";
      const [pidText, source, backup, outside] = process.argv.slice(1);
      const descriptorRoot = \`/proc/\${pidText}/fd\`;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      process.stdout.write("ready\\n");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        let descriptors = [];
        try { descriptors = readdirSync(descriptorRoot); } catch {}
        for (const descriptor of descriptors) {
          try {
            if (realpathSync(\`\${descriptorRoot}/\${descriptor}\`) !== source) continue;
            renameSync(source, backup);
            symlinkSync(outside, source, "dir");
            process.stdout.write("swapped\\n");
            process.exit(0);
          } catch {}
        }
        Atomics.wait(sleeper, 0, 0, 1);
      }
      process.exit(2);
    `;
    swapper = spawn(
      process.execPath,
      ["--input-type=module", "-e", swapScript, String(process.pid), source, backup, outside],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const exitPromise = once(swapper, "exit");
    const [ready] = await once(swapper.stdout, "data");
    assert.match(String(ready), /ready/u);

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const [exitCode, signal] = await exitPromise;
    assert.equal(signal, null);
    assert.equal(exitCode, 0);
    const evidence = await readEvidenceTree(target);
    assert.equal(evidence.includes(outsideNameSecret), false);
    assert.equal(evidence.includes(outsideContentSecret), false);
  } finally {
    swapper?.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("hard-linked evidence sources fail closed before their contents are read", async (context) => {
  if (process.platform === "win32") {
    context.skip("Hard-link behavior is covered on POSIX acceptance hosts.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-hard-link-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const hardLinkSecret = "HARD-LINK-SECRET-MUST-NOT-SURVIVE";
    await writeFile(fixture.options.resultPath, `${hardLinkSecret}\n`);
    await link(fixture.options.resultPath, join(directory, "outside-profile-result-link"));

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const evidence = await readEvidenceTree(target);
    assert.equal(evidence.includes(hardLinkSecret), false);
    const failure = JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
    assert.equal(
      failure.skippedFiles.some((entry) => entry.reason === "multiple-links"),
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("same-inode rewrites after the scanned prefix fail closed", async (context) => {
  if (process.platform !== "linux") {
    context.skip("The deterministic same-inode rewrite proof uses Linux /proc descriptor offsets.");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-same-inode-"));
  let mutator;
  try {
    const fixture = await createEvidenceFixture(directory);
    const source = fixture.options.resultPath;
    const mutationSecret = "SAME-INODE-PRIVATE-MATERIAL-MUST-NOT-SURVIVE";
    const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${mutationSecret}\n`;
    await writeFile(source, Buffer.alloc(EVIDENCE_SOURCE_LIMIT, 0x61));
    const before = await stat(source, { bigint: true });

    const mutateScript = `
      import { closeSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from "node:fs";
      const [pidText, source, thresholdText, privateKey] = process.argv.slice(1);
      const descriptorRoot = \`/proc/\${pidText}/fd\`;
      const sleeper = new Int32Array(new SharedArrayBuffer(4));
      process.stdout.write("ready\\n");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        let descriptors = [];
        try { descriptors = readdirSync(descriptorRoot); } catch {}
        for (const descriptor of descriptors) {
          try {
            if (realpathSync(\`\${descriptorRoot}/\${descriptor}\`) !== source) continue;
            const info = readFileSync(\`/proc/\${pidText}/fdinfo/\${descriptor}\`, "utf8");
            const position = Number(/^pos:\\s+([0-9]+)/mu.exec(info)?.[1] ?? 0);
            if (position < Number(thresholdText)) continue;
            const target = openSync(source, "r+");
            try { writeSync(target, privateKey, 0, "utf8"); } finally { closeSync(target); }
            process.stdout.write("mutated\\n");
            process.exit(0);
          } catch {}
        }
        Atomics.wait(sleeper, 0, 0, 1);
      }
      process.exit(2);
    `;
    mutator = spawn(
      process.execPath,
      ["--input-type=module", "-e", mutateScript, String(process.pid), source, String(2 * 1024 * 1024), privateKey],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const exitPromise = once(mutator, "exit");
    const [ready] = await once(mutator.stdout, "data");
    assert.match(String(ready), /ready/u);

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const [exitCode, signal] = await exitPromise;
    assert.equal(signal, null);
    assert.equal(exitCode, 0);
    const after = await stat(source, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    const evidence = await readEvidenceTree(target);
    assert.equal(evidence.includes(mutationSecret), false);
    assert.equal(evidence.includes("BEGIN OPENSSH PRIVATE KEY"), false);
    const failure = JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
    assert.equal(
      failure.skippedFiles.some((entry) => entry.reason === "file-changed"),
      true
    );
  } finally {
    mutator?.kill("SIGKILL");
    await rm(directory, { recursive: true, force: true });
  }
});

test("an approximately 825 KiB escape-run private-key header fails closed across scan chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-escape-run-key-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const header = `-----BEGIN ${"A".repeat(141)} PRIVATE KEY-----`;
    const escapeRunLength = 4_992;
    const encodedHeader = [...header]
      .map((character) => `${"\\".repeat(escapeRunLength)}u00${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .join("");
    const encodedBytes = Buffer.byteLength(encodedHeader);
    assert.ok(encodedBytes >= 824 * 1024 && encodedBytes <= 826 * 1024);
    const secretTail = "ESCAPE-RUN-PRIVATE-KEY-TAIL-MUST-NOT-SURVIVE";
    await writeFile(fixture.options.resultPath, `${encodedHeader}\n${secretTail}\n`);

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const evidence = await readEvidenceTree(target);
    assert.equal(evidence.includes(secretTail), false);
    const failure = JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
    assert.equal(
      failure.skippedFiles.some((entry) => entry.path === "verify-result.json" && entry.reason === "private-key"),
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("full-source normalization rejects deeply nested private-key escapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-nested-key-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const header = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const encodeLayer = (value) =>
      [...value]
        .map((character) => `${"\\".repeat(64)}u00${character.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join("");
    const encodedHeader = encodeLayer(encodeLayer(encodeLayer(header)));
    assert.ok(Buffer.byteLength(encodedHeader) < EVIDENCE_SOURCE_LIMIT);
    const secret = "DEEPLY-NESTED-PRIVATE-BODY-MUST-NOT-SURVIVE";
    await writeFile(fixture.options.resultPath, `${encodedHeader}\n${secret}\n`);

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const evidence = await readEvidenceTree(target);
    assert.equal(evidence.includes(secret), false);
    const failure = JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
    assert.equal(
      failure.skippedFiles.some((entry) => entry.path === "verify-result.json" && entry.reason === "private-key"),
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credentials are redacted before the retained tail is selected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-before-tail-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const secret = "CREDENTIAL-VALUE-CROSSES-THE-TAIL-BOUNDARY";
    const value = `${"x".repeat(200 * 1024)}${secret}`;
    await writeFile(fixture.options.resultPath, `password="${value}"\n${"z".repeat(400 * 1024)}`);

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const evidence = await readEvidenceTree(target);
    assert.equal(evidence.includes(secret), false);
    assert.equal(evidence.includes(value), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a regex-hostile bounded source is omitted without aborting failure evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-redaction-bound-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const hostile = `"${"a".repeat(EVIDENCE_SOURCE_LIMIT - 1)}`;
    await writeFile(fixture.options.resultPath, hostile);
    assert.equal(redactEditorAcceptanceText(hostile), undefined);

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const failure = JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
    assert.equal(
      failure.skippedFiles.some(
        (entry) => entry.path === "verify-result.json" && entry.reason === "redaction-rejected"
      ),
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("oversized allowlisted inputs are rejected before their contents are scanned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-source-cap-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const source = fixture.options.resultPath;
    const privateMaterial = "OVERSIZED-PRIVATE-MATERIAL-MUST-NOT-SURVIVE";
    const handle = await open(source, "w");
    try {
      await handle.write(`-----BEGIN OPENSSH PRIVATE KEY-----\n${privateMaterial}\n`, 0, "utf8");
      await handle.truncate(EVIDENCE_SOURCE_LIMIT + 1);
    } finally {
      await handle.close();
    }

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const evidence = await readEvidenceTree(target);
    assert.equal(evidence.includes(privateMaterial), false);
    const failure = JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
    assert.equal(
      failure.skippedFiles.some((entry) => entry.reason === "source-too-large"),
      true
    );
    assert.equal(
      failure.skippedFiles.some((entry) => entry.reason === "private-key"),
      false,
      "The source-size cap must be enforced before the full private-key scan."
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejected sources consume the hard candidate budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-candidate-budget-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    for (let index = 0; index < EVIDENCE_SOURCE_CANDIDATE_LIMIT + 8; index += 1) {
      const logDirectory = join(fixture.logRoot, `candidate-${String(index).padStart(3, "0")}`);
      await mkdir(logDirectory);
      await writeFile(join(logDirectory, "main.log"), Buffer.from([0xff]));
    }

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const failure = JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
    const candidateBudgetSkips = failure.skippedFiles.filter((entry) => entry.reason === "source-candidate-budget");
    assert.equal(candidateBudgetSkips.length, 10);
    assert.equal(failure.skippedFiles.filter((entry) => entry.reason === "not-utf8").length, 62);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejected sources consume the aggregate source-scan byte budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-scan-budget-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const sourceCount = Math.ceil(EVIDENCE_SCAN_LIMIT / EVIDENCE_SOURCE_LIMIT) + 2;
    for (let index = 0; index < sourceCount; index += 1) {
      const logDirectory = join(fixture.logRoot, `scan-${String(index).padStart(2, "0")}`);
      await mkdir(logDirectory);
      const logPath = join(logDirectory, "main.log");
      const handle = await open(logPath, "w");
      try {
        await handle.truncate(EVIDENCE_SOURCE_LIMIT);
        await handle.write(Buffer.from([0xff]), 0, 1, EVIDENCE_SOURCE_LIMIT - 1);
      } finally {
        await handle.close();
      }
    }

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const failure = JSON.parse(await readFile(join(target, "failure.json"), "utf8"));
    assert.equal(failure.skippedFiles.filter((entry) => entry.reason === "source-scan-budget").length, 3);
    assert.equal(failure.skippedFiles.filter((entry) => entry.reason === "not-utf8").length, 3);
    assert.equal(
      failure.copiedFiles.some((entry) => entry.startsWith("logs/")),
      false
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile traversal bounds child enumeration and the manifest before 4,000 entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-traversal-cap-"));
  try {
    const fixture = await createEvidenceFixture(directory);
    const noise = join(fixture.options.profile, "noise");
    await mkdir(noise);
    const fileCount = MANIFEST_ENTRY_LIMIT + 200;
    for (let start = 0; start < fileCount; start += 200) {
      await Promise.all(
        Array.from({ length: Math.min(200, fileCount - start) }, (_, offset) =>
          writeFile(join(noise, `entry-${String(start + offset).padStart(5, "0")}.txt`), "noise\n")
        )
      );
    }

    const target = retainEditorAcceptanceEvidence(fixture.options);
    const manifest = JSON.parse(await readFile(join(target, "profile-manifest.json"), "utf8"));
    assert.equal(manifest.length, MANIFEST_ENTRY_LIMIT);
    assert.ok(manifest.filter((entry) => entry.path.startsWith("noise/")).length < fileCount);
    assert.equal(
      manifest.some((entry) => entry.path === "verify-result.json"),
      true
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("log evidence obeys both file-count and aggregate byte budgets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-budget-"));
  try {
    const countCase = await createEvidenceFixture(join(directory, "count"));
    for (let index = 0; index < 25; index += 1) {
      const logDirectory = join(countCase.logRoot, `window-${String(index).padStart(2, "0")}`);
      await mkdir(logDirectory, { recursive: true });
      await writeFile(join(logDirectory, "main.log"), `log ${index}\n`);
    }
    const countTarget = retainEditorAcceptanceEvidence(countCase.options);
    const countFailure = JSON.parse(await readFile(join(countTarget, "failure.json"), "utf8"));
    assert.equal(countFailure.copiedFiles.filter((path) => path.startsWith("logs/")).length, 24);
    assert.equal(countFailure.skippedFiles.filter((entry) => entry.reason === "bundle-budget").length, 1);

    const bytesCase = await createEvidenceFixture(join(directory, "bytes"));
    const oneLog = "x".repeat(LOG_FILE_LIMIT);
    for (let index = 0; index < 17; index += 1) {
      const logDirectory = join(bytesCase.logRoot, `window-${String(index).padStart(2, "0")}`);
      await mkdir(logDirectory, { recursive: true });
      await writeFile(join(logDirectory, "main.log"), oneLog);
    }
    const bytesTarget = retainEditorAcceptanceEvidence(bytesCase.options);
    const bytesFailure = JSON.parse(await readFile(join(bytesTarget, "failure.json"), "utf8"));
    const retainedLogs = bytesFailure.copiedFiles.filter((path) => path.startsWith("logs/"));
    const totalBytes = (
      await Promise.all(retainedLogs.map((path) => stat(join(bytesTarget, ...path.split("/")))))
    ).reduce((total, metadata) => total + metadata.size, 0);
    assert.ok(totalBytes <= LOG_BUNDLE_LIMIT);
    assert.equal(retainedLogs.length, 16);
    assert.equal(bytesFailure.skippedFiles.filter((entry) => entry.reason === "bundle-budget").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the clear helper removes only a bounded evidence root and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-evidence-clear-"));
  const evidenceRoot = join(directory, "evidence");
  try {
    await mkdir(evidenceRoot);
    await writeFile(join(evidenceRoot, "failure.json"), "{}\n");
    clearEditorAcceptanceEvidence(evidenceRoot);
    await assert.rejects(lstat(evidenceRoot), { code: "ENOENT" });
    clearEditorAcceptanceEvidence(evidenceRoot);
    assert.throws(() => clearEditorAcceptanceEvidence(""), /non-empty path/u);
    assert.throws(() => clearEditorAcceptanceEvidence(parse(resolve(directory)).root), /filesystem root/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createEvidenceFixture(root) {
  const temporaryRoot = join(root, "editor-temp");
  const profile = join(temporaryRoot, "profile");
  const resultPath = join(profile, "verify-result.json");
  const logRoot = join(profile, "user-data", "logs");
  await mkdir(logRoot, { recursive: true });
  await writeFile(resultPath, "{}\n");
  return {
    logRoot,
    options: {
      evidenceRoot: join(root, "evidence"),
      temporaryRoot,
      profile,
      editor: { key: "vscode", name: "VS Code", version: "1.129.0" },
      phase: "verify",
      error: new Error("failed"),
      hostHome: process.env.HOME,
      resultPath
    }
  };
}

async function readEvidenceTree(root) {
  const parts = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) parts.push(await readFile(path, "utf8"));
    }
  }
  return parts.join("\n");
}

async function readEvidenceNames(root) {
  const names = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      names.push(entry.name);
      if (entry.isDirectory()) pending.push(join(current, entry.name));
    }
  }
  return names.join("\n");
}
