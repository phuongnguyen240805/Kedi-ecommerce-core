import importlib.util
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('settings',Path(__file__).with_name('append-commerce-settings.py'));settings=importlib.util.module_from_spec(spec);spec.loader.exec_module(settings)
class CommerceSettingsTests(unittest.TestCase):
 def test_shell_metacharacters_remain_literal_and_unknown_keys_are_not_imported(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'settings.env';value='Business $literal "quotes" '+chr(96)+'text'+chr(96)
   self.assertEqual(settings.append_settings(p,{'MARKETING_CONTACT_ADDRESS':value,'MARKETING_ENABLED':'false','UNRELATED_SECRET':'hidden'}),2)
   self.assertIn('MARKETING_CONTACT_ADDRESS='+value,p.read_text());self.assertNotIn('hidden',p.read_text())
 def test_invalid_values_do_not_partially_append(self):
  with tempfile.TemporaryDirectory() as tmp:
   p=Path(tmp)/'settings.env';p.write_text('original')
   for bad in [{'MARKETING_ENABLED':'yes'},{'CHECKOUT_PAYMENTS_PAUSED':'yes'},{'ACP_ACCESS_VERIFIED':'yes'},{'MARKETING_POLICY_VERSION':'x\nINJECTED=1'}]:
    with self.assertRaises(ValueError):settings.append_settings(p,bad)
    self.assertEqual(p.read_text(),'original')
if __name__=='__main__':unittest.main()
