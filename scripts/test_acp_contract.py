"""Validate real HTTP fixtures against pinned upstream ACP schemas, with no network refs."""
import json
import sys
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

def validate(fixtures):
    root=json.loads((Path(__file__).parent.parent/'apps/merchant/tests/contracts/acp-2026-04-17.schema.json').read_text(encoding='utf-8'))
    def check(name,value):
        schema={'$schema':root['$schema'],'components':root['components'],'$ref':'#/components/schemas/'+name}
        return list(Draft202012Validator(schema,format_checker=FormatChecker()).iter_errors(value))
    if check('CheckoutSessionCreateRequest',fixtures['request']):
        raise ValueError('ACP request fixture does not match pinned upstream schema')
    for name in ['created','updated','claimed','pending','completed','canceled']:
        errors=check('CheckoutSession',fixtures[name])
        if errors:
            raise ValueError('ACP '+name+' response violates schema at '+str(list(errors[0].path)))
    malformed=dict(fixtures['created']);malformed.pop('capabilities')
    if not check('CheckoutSession',malformed):
        raise ValueError('Schema validation failed to reject a missing required field')
    malformed=dict(fixtures['created']);malformed['status']='ready_for_complete'
    if not check('CheckoutSession',malformed):
        raise ValueError('Schema validation failed to reject UCP status in ACP response')
    print('ACP request + 6 real HTTP responses match pinned 2026-04-17 schema; negative required/status controls passed.')

if __name__=='__main__':
    validate(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
