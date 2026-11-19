"""Reuse an existing auto-provisioned KV namespace after an interrupted deployment."""
import json
import os
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

def resolve(config, account, token, opener=urlopen):
    if not re.fullmatch(r'[a-fA-F0-9]{32}', account) or not token:
        raise ValueError('Cloudflare account/token required for KV resolution')
    pending = [b for b in config.get('kv_namespaces', []) if not b.get('id')]
    if not pending:
        return config
    namespaces = []
    for page in range(1, 101):
        request = Request('https://api.cloudflare.com/client/v4/accounts/'+account+'/storage/kv/namespaces?per_page=100&page='+str(page), headers={'Authorization':'Bearer '+token,'Accept':'application/json'})
        with opener(request, timeout=20) as response:
            raw = response.read(1048577)
            if len(raw)>1048576:
                raise ValueError('KV namespace response too large')
            body=json.loads(raw)
        if body.get('success') is not True or not isinstance(body.get('result'),list):
            raise ValueError('Cannot list KV namespaces for deployment')
        namespaces.extend(body['result'])
        if page >= int(body.get('result_info',{}).get('total_pages',1)):
            break
    else:
        raise ValueError('Too many KV namespaces to resolve safely')
    for binding in pending:
        title=config['name']+'-'+binding['binding'].lower().replace('_','-')
        found=[n for n in namespaces if n.get('title')==title]
        if len(found)>1:
            raise ValueError('Multiple matching KV namespaces; configure KV_CACHE_ID explicitly')
        if found:
            if not re.fullmatch(r'[a-fA-F0-9]{32}',str(found[0].get('id',''))):
                raise ValueError('Invalid KV namespace identifier')
            binding['id']=found[0]['id']
    return config

if __name__=='__main__':
    try:
        path=Path(sys.argv[1])
        config=resolve(json.loads(path.read_text(encoding='utf-8')),os.environ.get('CLOUDFLARE_ACCOUNT_ID',''),os.environ.get('CLOUDFLARE_API_TOKEN',''))
        path.write_text(json.dumps(config,indent=2)+'\n',encoding='utf-8')
    except Exception:
        print('KV binding resolution failed. Check account permissions and namespace configuration.',file=sys.stderr)
        sys.exit(1)
    print('KV bindings resolved; existing namespaces reused where present. No remote data changed.')
