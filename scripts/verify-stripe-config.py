"""Read-only Stripe acceptance: never creates sessions, events, orders or charges."""
import json
import os
import urllib.request

REQUIRED = {'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.expired'}
ENDPOINT = 'https://merchant.gofiber-phuongnguyen.workers.dev/v1/webhooks/stripe'

def verify(key, signing_secret, opener=urllib.request.urlopen):
    if not key or not signing_secret:
        raise ValueError('Both Stripe API and webhook secrets must be configured')
    if key != key.strip() or signing_secret != signing_secret.strip() or not signing_secret.startswith('whsec_'):
        raise ValueError('Invalid secret format or surrounding whitespace')
    def get(path):
        request=urllib.request.Request('https://api.stripe.com/v1/'+path,headers={'Authorization':'Bearer '+key})
        try:
            with opener(request,timeout=20) as response:
                result=json.load(response)
        except Exception:
            raise ValueError('Stripe read-only API verification failed; check key, mode and read permissions') from None
        return result
    balance=get('balance')
    if not isinstance(balance.get('livemode'),bool):
        raise ValueError('Stripe mode could not be verified')
    matches=[]; cursor=''
    for _ in range(10):
        page=get('webhook_endpoints?limit=100'+('&starting_after='+cursor if cursor else ''))
        matches.extend(e for e in page.get('data',[]) if e.get('url')==ENDPOINT and e.get('status')=='enabled' and e.get('livemode')==balance['livemode'])
        if not page.get('has_more'):break
        if not page.get('data'):raise ValueError('Invalid webhook pagination')
        cursor=page['data'][-1]['id']
    compatible=[e for e in matches if REQUIRED.issubset(set(e.get('enabled_events',[]))) or '*' in e.get('enabled_events',[])]
    if not compatible:
        raise ValueError('No enabled webhook in the same Stripe mode matches the endpoint and three required events')
    return {'api_authenticated':True,'mode':'live' if balance['livemode'] else 'test','endpoint_and_events_verified':True,'signing_secret_present':True,'signing_secret_delivery_verified':False,'payment_tested':False}

if __name__=='__main__':
    try:
        print(json.dumps(verify(os.environ.get('STRIPE_SECRET_KEY',''),os.environ.get('STRIPE_WEBHOOK_SECRET',''))))
    except ValueError as error:
        print(str(error))
        raise SystemExit(1)
