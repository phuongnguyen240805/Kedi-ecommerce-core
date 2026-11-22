import type {MarketingKind} from './marketing-core';
const escape=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function marketingTemplate(input:{kind:MarketingKind;brand:string;subject?:string;text?:string;link:string;preferences:string;address:string}){
 const content={
  confirmation:{subject:'Confirm your email preferences',text:`Confirm that you want to receive news and offers from ${input.brand}.`,cta:'Confirm subscription'},
  welcome:{subject:`Welcome to ${input.brand}`,text:`Thanks for joining ${input.brand}. Discover our products and choose something you love.`,cta:'Explore the shop'},
  abandoned:{subject:'Your saved cart is waiting',text:'Return to your saved cart to review current availability, prices and delivery. Continue only when you are ready.',cta:'Review saved cart'},
  post_purchase:{subject:`How was your ${input.brand} order?`,text:'Your order was marked as delivered. We would love to hear how it went. If you need help, reply to this email.',cta:'Visit the shop'},
  win_back:{subject:`Explore ${input.brand} again`,text:'It has been a while since your last purchase. Visit the shop to discover what is currently available.',cta:'Discover products'}
 }[input.kind];
 const subject=input.subject||content.subject,text=input.text||content.text;
 return {subject,text:`${text}\n\n${content.cta}: ${input.link}\n\nEmail preferences: ${input.preferences}\n${input.address}`,
 html:`<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.6"><main style="max-width:600px;margin:auto;padding:24px"><h1>${escape(input.brand)}</h1><h2>${escape(subject)}</h2><p style="white-space:pre-line">${escape(text)}</p><p><a style="display:inline-block;padding:12px 20px;background:#b94716;color:#fff;border-radius:8px" href="${escape(input.link)}">${escape(content.cta)}</a></p><hr><p><a href="${escape(input.preferences)}">Unsubscribe / email preferences</a></p><p>${escape(input.address)}</p></main></body></html>`};
}
