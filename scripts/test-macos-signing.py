#!/usr/bin/env python3
"""Native signing/identity regression checks. Never launches an app or grants TCC access."""
import base64
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SIGNER = ROOT / 'scripts/macos-signing.py'
IDENTIFIER = 'dev.sharecode.signing-regression'


def call(*args, env=None):
    return subprocess.run([str(a) for a in args], capture_output=True, text=True, env=env)


class SigningTests(unittest.TestCase):
    def test_native_identity_and_failure_cleanup(self):
        initial = call('security', 'list-keychains', '-d', 'user').stdout
        pin = json.loads((ROOT / 'docs/macos/signing-identity.json').read_text())
        local = Path.home() / '.tauri/sharecode-macos'
        # Exercise the same base64/password ingestion used by CI, without uploading them.
        env = dict(os.environ, CI='true',
                   SHARECODE_MACOS_CERTIFICATE_BASE64=base64.b64encode((local / 'identity.p12').read_bytes()).decode(),
                   SHARECODE_MACOS_CERTIFICATE_PASSWORD=(local / 'password').read_text())
        with tempfile.TemporaryDirectory(prefix='sharecode-signing-test-') as tmp:
            tmp = Path(tmp)
            apps = []
            for version in (1, 2):
                app = tmp / f'{version}.app'
                (app / 'Contents/MacOS').mkdir(parents=True)
                (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
                    'CFBundleIdentifier': IDENTIFIER, 'CFBundleExecutable': 'fixture',
                    'CFBundleName': 'ShareCode Signing Regression', 'CFBundleVersion': str(version),
                    'CFBundlePackageType': 'APPL'}))
                source = tmp / 'main.c'
                source.write_text(f'int main(void) {{ return {version}; }}\n')
                result = call('cc', source, '-o', app / 'Contents/MacOS/fixture')
                self.assertEqual(result.returncode, 0, result.stderr)
                # Ad-hoc signatures must never pass the release verifier.
                result = call('codesign', '--force', '--sign', '-', app)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotEqual(call(sys.executable, SIGNER, 'verify', app, '--identifier', IDENTIFIER).returncode, 0)
                result = call(sys.executable, SIGNER, 'run', '--', 'codesign', '--force', '--sign', pin['sha1'], '--timestamp=none', app, env=env)
                self.assertEqual(result.returncode, 0, result.stderr)
                result = call(sys.executable, SIGNER, 'verify', app, '--identifier', IDENTIFIER)
                self.assertEqual(result.returncode, 0, result.stderr)
                apps.append(app)
            a = call('codesign', '-d', '-r-', apps[0])
            requirement = next(line.removeprefix('designated => ') for line in (a.stdout + a.stderr).splitlines() if line.startswith('designated => '))
            result = call('codesign', '--verify', '-R', '=' + requirement, apps[1])
            self.assertEqual(result.returncode, 0, result.stderr)
            # Even a certificate-signed app must fail if a build changes its DR.
            result = call(sys.executable, SIGNER, 'run', '--', 'codesign', '--force', '--sign', pin['sha1'],
                          '--timestamp=none', '-r', '=designated => identifier "wrong.identity"', apps[1], env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotEqual(call(sys.executable, SIGNER, 'verify', apps[1], '--identifier', IDENTIFIER).returncode, 0)
            # Child failure must propagate, restore the search list and delete temporary keys.
            result = call(sys.executable, SIGNER, 'run', '--', sys.executable, '-c', 'raise SystemExit(17)', env=env)
            self.assertEqual(result.returncode, 17)
            self.assertEqual(initial, call('security', 'list-keychains', '-d', 'user').stdout)
            # A different valid P12 with the same display name must be rejected before child launch.
            result = call('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                          '-subj', '/CN=ShareCode Client Code Signing/', '-addext', 'extendedKeyUsage=codeSigning',
                          '-keyout', tmp / 'wrong.key', '-out', tmp / 'wrong.pem')
            self.assertEqual(result.returncode, 0)
            result = call('openssl', 'pkcs12', '-export', '-legacy', '-inkey', tmp / 'wrong.key',
                          '-in', tmp / 'wrong.pem', '-out', tmp / 'wrong.p12', '-passout', 'pass:disposable-test')
            self.assertEqual(result.returncode, 0)
            wrong_env = dict(env, SHARECODE_MACOS_CERTIFICATE_BASE64=base64.b64encode((tmp / 'wrong.p12').read_bytes()).decode(),
                             SHARECODE_MACOS_CERTIFICATE_PASSWORD='disposable-test')
            result = call(sys.executable, SIGNER, 'run', '--', '/usr/bin/true', env=wrong_env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('does not match', result.stderr)
            self.assertEqual(initial, call('security', 'list-keychains', '-d', 'user').stdout)
        missing = dict(os.environ, CI='true')
        missing.pop('SHARECODE_MACOS_CERTIFICATE_BASE64', None)
        missing.pop('SHARECODE_MACOS_CERTIFICATE_PASSWORD', None)
        result = call(sys.executable, SIGNER, 'run', '--', '/usr/bin/true', env=missing)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('No ad-hoc fallback', result.stderr)


if __name__ == '__main__':
    os.umask(0o077)
    unittest.main()
