import {Hono} from 'hono';import {bodyLimit} from 'hono/body-limit';import {authMiddleware,adminOnly} from '../middleware/auth';import type {HonoEnv} from '../types';import {catalogImport,storefrontAccess} from '../lib/storefront-migration';
export const storefrontMigration=new Hono<HonoEnv>();storefrontMigration.use('*',bodyLimit({maxSize:512000}),authMiddleware,adminOnly,async(c,next)=>{c.header('Cache-Control','private, no-store');await next();});
storefrontMigration.post('/catalog',async c=>c.json(await c.var.db.storefrontImport(catalogImport.parse(await c.req.json()),c.var.auth.sub||'admin-api-key')));
storefrontMigration.post('/public-access',async c=>c.json(await c.var.db.storefrontAccess(storefrontAccess.parse(await c.req.json()))));
