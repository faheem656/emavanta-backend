import { collection } from '../../../../packages/database/store.js';
import { registerWorker } from '../../../../packages/queue/index.js';
import { sendAuthMail } from '../mail-auth.js';

// SMTP can accept a message immediately before a process crashes. Retries are
// at-least-once; delivery may duplicate after an ambiguous failure.
export async function deliverContactNotification({contactId},job) {
 const contacts=collection('contact_messages'), row=await contacts.findOne({_id:contactId});
 if(!row || row.deliveryStatus==='sent')return;
 const owner=String(process.env.PLATFORM_OWNER_EMAIL||'').trim();
 if(!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(owner))throw Object.assign(new Error('Owner email is not configured'),{code:'CONTACT_OWNER_CONFIG'});
 const result=await sendAuthMail({to:owner,replyTo:row.email,kind:'contact notification',subject:'New Emavanta contact request',text:`Reference: ${row._id.slice(0,8)}\nName: ${row.name}\nEmail: ${row.email}\nCompany: ${row.company||'Not provided'}\nTopic: ${row.topic}\n\nMessage:\n${row.message}`});
 if(!result.sent){await contacts.updateOne({_id:contactId},{$set:{deliveryStatus:(job?.attempts >= (job?.opts?.attempts||4) ? 'failed' : 'retrying'),lastDeliveryError:'Email delivery failed; check SMTP settings.',lastAttemptAt:new Date().toISOString()}});throw Object.assign(new Error('Contact notification failed'),{code:'CONTACT_MAIL_FAILED'});}
 await contacts.updateOne({_id:contactId},{$set:{deliveryStatus:'sent',sentAt:new Date().toISOString(),lastDeliveryError:null}});
}
export const startContactMailWorker=()=>registerWorker('contact_mail',deliverContactNotification);
