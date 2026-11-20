import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,resolve,sep} from 'node:path';
import {unstable_dev} from 'wrangler';
import {createServer} from 'node:http';

test('Workers runtime keeps Printify admin reads available while POD remains disabled',{timeout:90000},async()=>{
  const provider=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify([{id:123,title:'Native fetch shop',sales_channel:'custom_integration'}]));});
  await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));
  const address=provider.address();if(!address||typeof address==='string')throw Error('Provider fixture not listening');
  const providerUrl=`http://127.0.0.1:${address.port}`;
  const root=fileURLToPath(new URL('../.wrangler/',import.meta.url));mkdirSync(root,{recursive:true});
  const dir=mkdtempSync(join(root,'printify-readonly-'));
  const modulePath=(name:string)=>JSON.stringify(fileURLToPath(new URL(`../src/${name}`,import.meta.url)).replaceAll('\\','/'));
  const main=join(dir,'worker.ts'),config=join(dir,'wrangler.json');
  writeFileSync(main,`
    import {Hono} from 'hono';
    import {pod} from ${modulePath('routes/pod.ts')};
    import {printifyAdmin} from ${modulePath('routes/printify-admin.ts')};
    import {authMiddleware,adminOnly} from ${modulePath('middleware/auth.ts')};
    import {ApiError} from ${modulePath('types.ts')};
    import {PrintifyReadonlyClient} from ${modulePath('lib/printify-readonly.ts')};
    const app=new Hono();
    app.use('*',async(c,next)=>{c.set('db',{query:async()=>[{id:'fixture',role:'admin'}]});await next();});
    app.onError((e,c)=>c.json({error:e.message},e instanceof ApiError?e.statusCode:500));
    app.route('/pod',pod);
    // Retain the actual runtime fetch and its receiver semantics, redirecting only
    // the destination to a local provider fixture. No Printify network access.
    app.get('/native',async c=>{
      const transport=new Proxy(fetch,{apply(target,receiver,args){return Reflect.apply(target,receiver,[${JSON.stringify(providerUrl)},args[1]]);}});
      return c.json(await new PrintifyReadonlyClient('fixture','123',transport).connection());
    });
    app.use('/fixture/*',authMiddleware,adminOnly);
    app.route('/fixture',printifyAdmin(async(url,init)=>{
      if(init.method!=='GET'||init.redirect!=='manual')throw Error('Unexpected provider mutation');
      if(String(url)!=='https://api.printify.com/v1/shops.json')throw Error('Unexpected URL');
      return Response.json([{id:123,title:'Runtime shop',sales_channel:'custom_integration',secret:'strip-me'}]);
    }));
    export default app;
  `);
  writeFileSync(config,JSON.stringify({name:'printify-readonly-runtime',main,compatibility_date:'2025-12-01',compatibility_flags:['nodejs_compat'],vars:{POD_ENABLED:'false',PRINTIFY_SHOP_ID:'123',PRINTIFY_API_TOKEN:'runtime-fixture'}}));
  let worker:Awaited<ReturnType<typeof unstable_dev>>|undefined;
  try{
    worker=await unstable_dev(main,{config,local:true,persist:false,port:0,inspectorPort:0,logLevel:'error',experimental:{disableExperimentalWarning:true}});
    const headers={Authorization:'Bearer sk_fixture'};
    const native=await worker.fetch('/native');
    assert.equal(native.status,200,await native.clone().text());
    assert.equal((await native.json() as {connected:boolean}).connected,true);
    assert.equal((await worker.fetch('/pod/admin/printify/connection')).status,401);
    const connection=await worker.fetch('/fixture/connection',{headers});assert.equal(connection.status,200);
    assert.equal(connection.headers.get('Cache-Control'),'private, no-store');
    const body=await connection.text();assert.match(body,/Runtime shop/);assert.equal(body.includes('strip-me'),false);
    assert.equal(body.includes('runtime-fixture'),false);
    assert.equal((await worker.fetch('/pod/catalog',{headers})).status,503);
    assert.equal((await worker.fetch('/pod/checkout',{method:'POST',headers})).status,503);
  }finally{
    await worker?.stop();
    await new Promise<void>((resolve,reject)=>provider.close(error=>error?reject(error):resolve()));
    if(!resolve(dir).startsWith(resolve(root)+sep))throw Error('Unexpected runtime fixture directory');
    rmSync(dir,{recursive:true,force:true});
  }
});
