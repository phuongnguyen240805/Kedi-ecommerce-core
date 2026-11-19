"""Read-only CI credential preflight. Never prints response bodies or credentials."""
import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

def verify(account_id, token, opener=urlopen):
    if not re.fullmatch(r'[a-fA-F0-9]{32}', account_id):
        raise ValueError('CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID from the selected account.')
    if not token or token != token.strip() or '\r' in token or '\n' in token:
        raise ValueError('CLOUDFLARE_API_TOKEN is missing or contains whitespace; update the GitHub secret with the full token value.')
    request = Request('https://api.cloudflare.com/client/v4/accounts/'+account_id,
                      headers={'Authorization': 'Bearer '+token, 'Accept': 'application/json'})
    try:
        with opener(request, timeout=20) as response:
            # An account profile is small; bound the response even on unexpected upstream data.
            raw = response.read(65537)
            if len(raw) > 65536:
                raise ValueError('Cloudflare credential verification returned an unexpected response.')
            body = json.loads(raw)
    except (HTTPError, URLError, TimeoutError) as error:
        status = error.code if isinstance(error, HTTPError) else 'network'
        raise ValueError('Cloudflare account authorization failed ('+str(status)+'). Check token value, expiry, account scope, Account Settings Read and Workers edit permissions.') from None
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ValueError('Cloudflare credential verification returned an unexpected response.') from None
    if not isinstance(body, dict) or body.get('success') is not True or not isinstance(body.get('result'), dict) or body['result'].get('id') != account_id:
        raise ValueError('Cloudflare token does not authorize the configured account. Check the selected account and token scope.')

if __name__ == '__main__':
    try:
        verify(os.environ.get('CLOUDFLARE_ACCOUNT_ID', ''), os.environ.get('CLOUDFLARE_API_TOKEN', ''))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    print('Cloudflare token authorized for the configured account; no deployment performed.')
