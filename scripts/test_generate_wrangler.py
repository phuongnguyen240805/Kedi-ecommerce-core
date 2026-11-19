import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('generate-wrangler-jsonc.py')
spec = importlib.util.spec_from_file_location('generator', SCRIPT)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)
auth_spec = importlib.util.spec_from_file_location('verify_deploy', SCRIPT.with_name('verify-cloudflare-deploy.py'))
auth = importlib.util.module_from_spec(auth_spec)
auth_spec.loader.exec_module(auth)

class DeploymentConfigTests(unittest.TestCase):
    def test_ci_credentials_are_not_worker_secrets_but_ai_decryption_key_is_preserved(self):
        result = generator.runtime_secrets({
            'CLOUDFLARE_API_TOKEN': 'ci-only-fixture',
            'CLOUDFLARE_ACCOUNT_ID': 'account-fixture',
            'KV_CACHE_ID': 'namespace-fixture',
            'CLOUDFLARE_USE_PAGE_DEV_DOMAIN': 'true',
            'CRYPTOKEN': 'runtime-ai-decryption-fixture',
            'STORE_NAME': 'KediMuse',
            'STRIPE_SECRET_KEY': '',
            'OPTIONAL': '  ',
            'DISABLED_FLAG': 'false',
        })
        self.assertEqual(result, {'CRYPTOKEN': 'runtime-ai-decryption-fixture', 'STORE_NAME': 'KediMuse', 'DISABLED_FLAG': 'false'})

    def test_cli_keeps_resource_override_without_leaking_ci_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = root / 'base.json'
            env = root / 'settings.env'
            out = root / 'generated.json'
            base.write_text(json.dumps({'name': 'test-worker', 'vars': {'PUBLIC_FLAG': 'false'}, 'kv_namespaces': [{'binding': 'KV_CACHE'}]}), encoding='utf-8')
            env.write_text('CLOUDFLARE_API_TOKEN=never-upload-this\nCLOUDFLARE_ACCOUNT_ID=account-id\nKV_CACHE_ID='+'a'*32+'\nCRYPTOKEN=runtime-key\nSTORE_NAME=KediMuse\nAUTH0_DOMAIN=\n', encoding='utf-8')
            run = subprocess.run([sys.executable, str(SCRIPT), '--skip-routes', str(env), str(base), str(out)], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            config = json.loads(out.read_text(encoding='utf-8'))
            secrets = json.loads((root/'secrets.json').read_text(encoding='utf-8'))
            self.assertEqual(config['kv_namespaces'][0]['id'], 'a'*32)
            self.assertEqual(config['secrets']['required'], ['CRYPTOKEN', 'STORE_NAME'])
            self.assertEqual(config['vars'], {'PUBLIC_FLAG': 'false'})
            self.assertNotIn('never-upload-this', out.read_text(encoding='utf-8'))
            self.assertNotIn('never-upload-this', json.dumps(secrets))
            self.assertNotIn('never-upload-this', run.stdout+run.stderr)

    def test_merchant_base_provisions_resources_without_foreign_placeholder_ids(self):
        config = json.loads((SCRIPT.parent.parent/'apps/merchant/wrangler.jsonc').read_text(encoding='utf-8'))
        self.assertIn('nodejs_compat', config['compatibility_flags'])
        self.assertTrue(config['observability']['enabled'])
        self.assertTrue(config['observability']['traces']['enabled'])
        for namespace in config['kv_namespaces']:
            self.assertNotIn('id', namespace)
        self.assertFalse(config.get('r2_buckets'), 'UCP-only deployment must not provision R2 before account activation')

    def test_authorization_preflight_is_read_only_and_binds_selected_account(self):
        account = 'a'*32
        requests = []
        def opener(request, timeout):
            requests.append(request)
            self.assertEqual(timeout, 20)
            return io.BytesIO(json.dumps({'success': True, 'result': {'id': account}}).encode())
        auth.verify(account, 'fixture-token', opener)
        self.assertEqual(requests[0].get_method(), 'GET')
        self.assertEqual(requests[0].full_url, 'https://api.cloudflare.com/client/v4/accounts/'+account)
        self.assertEqual(requests[0].get_header('Authorization'), 'Bearer fixture-token')

    def test_invalid_credentials_fail_without_echoing_secret_or_upstream_body(self):
        token = 'private-fixture-token'
        with self.assertRaises(ValueError) as error:
            auth.verify('a'*32, token, lambda request, timeout: io.BytesIO(json.dumps({'success': False, 'result': {'id': 'b'*32}, 'message': token}).encode()))
        self.assertNotIn(token, str(error.exception))
        with self.assertRaises(ValueError):
            auth.verify('wrong-account-id', token)
        with self.assertRaises(ValueError):
            auth.verify('a'*32, ' '+token)

if __name__ == '__main__':
    unittest.main()
