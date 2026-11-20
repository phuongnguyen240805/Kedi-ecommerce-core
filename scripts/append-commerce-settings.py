"""Append supported settings from CI env without shell interpolation."""
import os
from pathlib import Path
KEYS=('MARKETING_ENABLED','MARKETING_SEND_ENABLED','MARKETING_POLICY_VERSION','MARKETING_FROM_EMAIL','MARKETING_CONTACT_ADDRESS','MARKETING_WELCOME_DISCOUNT_CODE','MARKETING_MAILGUN_DOMAIN','MARKETING_MAILGUN_BASE_URL','MAILGUN_WEBHOOK_SIGNING_KEY','MARKETING_AI_ENABLED','MARKETING_AI_MODEL','MARKETING_OPENAI_API_KEY','STORE_PUBLIC_API_URL','FEEDS_ENABLED')
def append_settings(target,environ):
    values=[]
    for key in KEYS:
        value=environ.get(key,'')
        if not value:continue
        if any(c in value for c in ('\n','\r','\x00')):raise ValueError('Commerce setting must be a single line: '+key)
        if key.endswith('_ENABLED') and value not in ('true','false'):raise ValueError('Feature flag must be true or false: '+key)
        values.append(key+'='+value)
    with Path(target).open('a',encoding='utf-8') as output:output.write('\n'+'\n'.join(values)+'\n')
    return len(values)
if __name__=='__main__':print('Supported commerce settings appended:',append_settings('.env',os.environ))
