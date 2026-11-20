import importlib.util
import io
import json
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('stripe_verify',Path(__file__).with_name('verify-stripe-config.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class StripeConfigTests(unittest.TestCase):
 def test_authenticated_test_mode_matching_endpoint_and_events_are_read_only(self):
  calls=[]
  def opener(request,timeout):
   calls.append(request);self.assertEqual(request.get_method(),'GET')
   value={'livemode':False} if request.full_url.endswith('/balance') else {'data':[{'id':'we_fixture','url':module.ENDPOINT,'status':'enabled','livemode':False,'enabled_events':list(module.REQUIRED)}],'has_more':False}
   return io.BytesIO(json.dumps(value).encode())
  result=module.verify('sk_test_fixture','whsec_fixture',opener)
  self.assertEqual(result['mode'],'test');self.assertFalse(result['payment_tested']);self.assertFalse(result['signing_secret_delivery_verified']);self.assertEqual(len(calls),2)
 def test_missing_or_whitespace_secrets_fail_without_network(self):
  for key,secret in [('', 'whsec_x'),('sk_test_x',''),('sk_test_x ','whsec_x'),('sk_test_x','bad')]:
   with self.assertRaises(ValueError):module.verify(key,secret,lambda *a,**k:self.fail('Unexpected API call'))
 def test_wrong_mode_disabled_or_missing_events_do_not_pass(self):
  for override in [{'livemode':True},{'status':'disabled'},{'enabled_events':[]},{'url':'https://other.test'}]:
   endpoint={'url':module.ENDPOINT,'status':'enabled','livemode':False,'enabled_events':list(module.REQUIRED),**override}
   def opener(request,timeout):return io.BytesIO(json.dumps({'livemode':False} if request.full_url.endswith('/balance') else {'data':[endpoint]}).encode())
   with self.assertRaises(ValueError):module.verify('sk_test_fixture','whsec_fixture',opener)
 def test_api_failure_does_not_echo_credentials_or_upstream_response(self):
  def opener(request,timeout):raise RuntimeError('private-key-and-upstream-body')
  with self.assertRaises(ValueError) as error:module.verify('sk_test_private','whsec_private',opener)
  self.assertNotIn('private',str(error.exception))
if __name__=='__main__':unittest.main()
