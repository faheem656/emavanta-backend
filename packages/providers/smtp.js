import nodemailer from 'nodemailer';
export const testSmtp = async account => {
  const { host, port, secure, user, pass } = account.credentials || {};
  const transporter = nodemailer.createTransport({ host, port: Number(port || 587), secure: !!secure, auth: { user, pass }, connectionTimeout:12000, greetingTimeout:12000, socketTimeout:30000 });
  await transporter.verify();
  return true;
};
export const sendViaSmtp = async (account, message) => {
  const { host, port, secure, user, pass } = account.credentials || {};
  const transporter = nodemailer.createTransport({ host, port: Number(port || 587), secure: !!secure, auth: { user, pass }, connectionTimeout:12000, greetingTimeout:12000, socketTimeout:30000 });
  const info = await transporter.sendMail({ from: message.from, to: message.to, replyTo: message.replyTo, subject: message.subject, html: message.html,
    headers: { 'X-Campaign-Message': message.id, 'List-Unsubscribe': message.unsubscribeUrl ? `<${message.unsubscribeUrl}>` : undefined } });
  if(!info.accepted?.length)throw Object.assign(new Error('Provider did not accept recipient'),{code:'SMTP_NOT_ACCEPTED'});
  return { providerMessageId: info.messageId, accepted: true };
};
