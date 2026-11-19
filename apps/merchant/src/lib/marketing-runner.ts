import type {DOStub,Env} from '../types';
import {sendMailgunEmail} from '../mailgun';
import {marketingToken} from './marketing-tokens';
const escape=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export async function deliverMarketing(env:Env,db:DOStub){
 if(env.MARKETING_ENABLED!=='true'||env.MARKETING_SEND_ENABLED!=='true'||!env.MAILGUN_API_KEY||!(env.MARKETING_MAILGUN_DOMAIN||env.MAILGUN_DOMAIN)||!env.MARKETING_FROM_EMAIL||!env.MARKETING_CONTACT_ADDRESS||!env.STORE_URL||!env.STORE_PUBLIC_API_URL||!env.ORDER_TOKEN_SECRET||env.ORDER_TOKEN_SECRET.length<32)return;
 const storefront=new URL(env.STORE_URL);if(storefront.protocol!=='https:')return;
 for(let count=0;count<10;count++){
  const lease=crypto.randomUUID(),job=await db.marketingClaim(lease);if(!job)return;
  try{
   let subject='',text='',link=storefront.origin;
   if(job.kind==='confirmation'){
    const token=await marketingToken(env,'confirm',job.subscriber_id,{nonce:job.nonce});
    link=`${storefront.origin}/marketing-preferences#action=confirm&token=${encodeURIComponent(token)}`;
    subject='Confirm your email preferences';text='Confirm that you want to receive news and offers from '+env.STORE_NAME+'.';
   }else{
    const titles={welcome:'Welcome to '+env.STORE_NAME,abandoned:'Your cart is waiting',post_purchase:'How was your order?',win_back:'Discover something new'};
    subject=titles[job.kind];text=job.kind==='abandoned'?'Your payment has not been confirmed. Review your cart at its current price before deciding to buy.':'Explore the latest from '+env.STORE_NAME+'.';
    if(job.kind==='abandoned'){
     const token=await marketingToken(env,'recovery',job.subscriber_id,{cart_id:job.payload.cart_id,checkout_id:job.payload.checkout_id});
     link=`${storefront.origin}/marketing-preferences#action=recovery&token=${encodeURIComponent(token)}`;
    }
    if(job.kind==='welcome'&&env.MARKETING_WELCOME_DISCOUNT_CODE){
     const [discount]=await db.query<{code:string}>("SELECT code FROM discounts WHERE code=? AND status='active' AND (expires_at IS NULL OR julianday(expires_at)>julianday('now')) AND (starts_at IS NULL OR julianday(starts_at)<=julianday('now'))",[env.MARKETING_WELCOME_DISCOUNT_CODE]);
     if(discount)text+=` Your offer code is ${discount.code}. Eligibility and limits are checked at checkout.`;
    }
   }
   const unsubscribe=await marketingToken(env,'unsubscribe',job.subscriber_id);
   const unsubscribeUrl=env.STORE_PUBLIC_API_URL.replace(/\/$/,'')+'/v1/marketing/unsubscribe?token='+encodeURIComponent(unsubscribe);
   const preferences=`${storefront.origin}/marketing-preferences#action=unsubscribe&token=${encodeURIComponent(unsubscribe)}`;
   // Consent, suppression, paid-cart cancellation and lease are rechecked immediately before I/O.
   if(!await db.marketingEligible(job.id,lease)){await db.marketingFinish(job.id,lease,'dead');continue;}
   const result=await sendMailgunEmail({...env,MAILGUN_DOMAIN:env.MARKETING_MAILGUN_DOMAIN||env.MAILGUN_DOMAIN,MAILGUN_BASE_URL:env.MARKETING_MAILGUN_BASE_URL||env.MAILGUN_BASE_URL},{to:job.email,from:env.MARKETING_FROM_EMAIL,subject,
    text:`${text}\n${link}\n\nEmail preferences: ${preferences}\n${env.MARKETING_CONTACT_ADDRESS}`,
    html:`<p>${escape(text)}</p><p><a href="${escape(link)}">${job.kind==='confirmation'?'Confirm email':'Continue'}</a></p><p><a href="${escape(preferences)}">Unsubscribe</a></p><p>${escape(env.MARKETING_CONTACT_ADDRESS)}</p>`,
    unsubscribeUrl,marketingJobId:job.id,storeId:env.STORE_ID||'default'});
   const body=result.body as {id?:unknown};
   if(result.success&&typeof body?.id==='string')await db.marketingFinish(job.id,lease,'accepted',body.id);
   else await db.marketingFinish(job.id,lease,result.status===429?'retry':result.status>=500?'unknown':'dead');
  }catch{await db.marketingFinish(job.id,lease,'unknown');}
 }
}
