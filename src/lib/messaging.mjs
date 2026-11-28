// QuotePilot customer messaging — email + SMS behind provider interfaces.
//
// Every send goes through a transport object with one method:
//   send({to, subject, body}) -> {id, transport}
// Three transports exist:
//   OutboxTransport  — records messages in memory; used for demo mode and
//                      tests. Nothing leaves the process. This is the dry-run.
//   SmtpTransport    — a minimal, dependency-free SMTP client (implicit TLS
//                      for smtps://, plain for smtp://, AUTH PLAIN when the
//                      URL carries credentials). Live path: implemented here,
//                      exercised only against a real server (see claim audit).
//   HttpSmsTransport — POSTs JSON {from,to,body} with a bearer token to a
//                      generic SMS gateway endpoint. Live path, same caveat.
// buildMessaging(config) wires transports from the validated configuration;
// a channel with no provider configured is null and sends through it are
// refused by the caller, fail-closed.
import net from 'node:net';
import tls from 'node:tls';
import {randomUUID} from 'node:crypto';
import {HttpError} from './validators.mjs';

export class OutboxTransport {
  constructor(kind){this.kind=kind;this.messages=[];}
  async send(message){
    const record={id:'outbox-'+randomUUID(),transport:`outbox-${this.kind}`,at:new Date().toISOString(),...message};
    this.messages.push(record);
    return {id:record.id,transport:record.transport};
  }
}

export function parseSmtpUrl(raw){
  let u;try{u=new URL(raw);}catch{throw new Error('QP_SMTP_URL must be a valid smtp:// or smtps:// URL');}
  if(!['smtp:','smtps:'].includes(u.protocol)||!u.hostname)throw new Error('QP_SMTP_URL must be a valid smtp:// or smtps:// URL');
  return {
    secure:u.protocol==='smtps:',
    host:u.hostname,
    port:Number(u.port||(u.protocol==='smtps:'?465:25)),
    user:u.username?decodeURIComponent(u.username):'',
    pass:u.password?decodeURIComponent(u.password):'',
  };
}

export function formatEmailMessage({from,to,subject,body}){
  const clean=(s)=>String(s??'').replace(/[\r\n]+/g,' ').trim();
  const text=String(body??'').replace(/\r?\n/g,'\r\n').replace(/^\./gm,'..');
  return `From: ${clean(from)}\r\nTo: ${clean(to)}\r\nSubject: ${clean(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n.`;
}

export class SmtpTransport {
  constructor({url,from}){this.target=parseSmtpUrl(url);this.from=from;}
  async send({to,subject,body}){
    const {secure,host,port,user,pass}=this.target;
    const socket=await new Promise((resolve,reject)=>{
      const s=secure?tls.connect({host,port,servername:host}):net.connect({host,port});
      const done=(err)=>{s.destroy();reject(err instanceof Error?err:new Error('SMTP connection failed'));};
      s.setTimeout(10000,()=>done(new Error('SMTP connection timed out')));
      s.once('error',done);
      s.once(secure?'secureConnect':'connect',()=>resolve(s));
    });
    let buffer='';
    const waiters=[];
    socket.on('data',(chunk)=>{buffer+=chunk.toString('utf8');let idx;while((idx=buffer.indexOf('\r\n'))>=0){const line=buffer.slice(0,idx);buffer=buffer.slice(idx+2);const w=waiters.shift();if(w)w(line);}});
    // Simple line pump: accumulate full SMTP replies (handle multi-line "250-" continuations).
    const reply=()=>new Promise((resolve,reject)=>{
      let collected=[];
      const onLine=(line)=>{collected.push(line);if(/^\d{3} /.test(line)||/^\d{3}$/.test(line)){resolve(collected.join('\n'));}else{waiters.push(onLine);}};
      waiters.push(onLine);
    });
    const command=async(text,expect)=>{
      if(text!==null)socket.write(text+'\r\n');
      const answer=await reply();
      const code=Number(answer.slice(0,3));
      if(!expect.includes(code))throw new Error(`SMTP command refused (${code})`);
      return answer;
    };
    try{
      await command(null,[220]);
      await command(`EHLO quotepilot.local`,[250]);
      if(user){
        const token=Buffer.from(`\0${user}\0${pass}`,'utf8').toString('base64');
        await command(`AUTH PLAIN ${token}`,[235]);
      }
      await command(`MAIL FROM:<${this.from}>`,[250]);
      await command(`RCPT TO:<${to}>`,[250,251]);
      await command('DATA',[354]);
      socket.write(formatEmailMessage({from:this.from,to,subject,body})+'\r\n');
      await command(null,[250]);
      await command('QUIT',[221]).catch(()=>{});
      return {id:'smtp-'+randomUUID(),transport:'smtp'};
    }catch(err){
      throw err instanceof HttpError?err:new HttpError(503,'Email delivery failed');
    }finally{socket.destroy();}
  }
}

export class HttpSmsTransport {
  constructor({url,token,from,fetchImpl=fetch}){
    let u;try{u=new URL(url);}catch{throw new Error('QP_SMS_API_URL must be a valid URL');}
    if(u.protocol!=='https:'&&u.hostname!=='127.0.0.1'&&u.hostname!=='localhost')throw new Error('QP_SMS_API_URL must be HTTPS');
    this.url=url;this.token=token;this.from=from;this.fetch=fetchImpl;
  }
  async send({to,body}){
    let response;
    try{response=await this.fetch(this.url,{method:'POST',headers:{Authorization:`Bearer ${this.token}`,'Content-Type':'application/json'},body:JSON.stringify({from:this.from,to,body}),signal:AbortSignal.timeout(10000)});}
    catch{throw new HttpError(503,'SMS delivery failed');}
    if(!response.ok)throw new HttpError(503,'SMS delivery failed');
    let data={};try{data=await response.json();}catch{/* gateways may answer empty */}
    return {id:String(data.id||data.sid||('sms-'+randomUUID())),transport:'http-sms'};
  }
}

export function buildMessaging(config){
  let email=null,sms=null;
  if(config.emailProvider==='outbox')email=new OutboxTransport('email');
  else if(config.emailProvider==='smtp')email=new SmtpTransport({url:config.smtpUrl,from:config.emailFrom});
  if(config.smsProvider==='outbox')sms=new OutboxTransport('sms');
  else if(config.smsProvider==='http')sms=new HttpSmsTransport({url:config.smsApiUrl,token:config.smsApiToken,from:config.smsFrom});
  return {email,sms};
}

// --- Customer-facing message composition (pure; unit-tested) ---
const money=(n)=>`$${Number(n||0).toFixed(2)}`;
export function estimateEmail({companyName,lead,estimate}){
  const subject=`Your ${lead.Service} estimate from ${companyName}: ${money(estimate.total)}`;
  const body=[
    `Hello ${lead['Customer Name']},`,
    '',
    `Thank you for your inquiry. Your ${lead.Service} estimate from ${companyName} is ${money(estimate.total)}.`,
    `Itemized: base ${money(estimate.base)}, bedrooms ${money(estimate.bedroomCharge)}, bathrooms ${money(estimate.bathroomCharge)}, area ${money(estimate.areaCharge)}, add-ons ${money(estimate.addonCharge)}; minimum ${money(estimate.minimum)}; multiplier ${estimate.multiplier}.`,
    '',
    'This estimate was prepared from the pricing you requested and is subject to final scope verification and scheduling.',
    '',
    `— ${companyName} (via QuotePilot)`,
  ].join('\n');
  return {subject,body};
}
export function estimateSms({companyName,lead,estimate}){
  return {body:`${companyName}: your ${lead.Service} estimate is ${money(estimate.total)} (subject to scope verification and scheduling). Thank you for your inquiry.`};
}
export function followupEmail({companyName,lead,estimate}){
  const subject=`Following up on your ${lead.Service} estimate`;
  const body=[
    `Hello ${lead['Customer Name']},`,
    '',
    `Following up on your ${lead.Service} estimate of ${money(estimate.total)} from ${companyName}. If you would like to move forward or adjust the scope, just reply to this message.`,
    '',
    `— ${companyName} (via QuotePilot)`,
  ].join('\n');
  return {subject,body};
}
export function bookingConfirmation({companyName,lead,booking}){
  const when=booking['Booked Date'];
  return {
    subject:`Booking confirmed: ${lead.Service} on ${when}`,
    emailBody:[`Hello ${lead['Customer Name']},`,'',`${companyName} has confirmed your ${lead.Service} booking for ${when}. The booked amount is ${money(booking.Amount)}.`,'','If anything changes, reply to this message and the business will take care of it.','',`— ${companyName} (via QuotePilot)`].join('\n'),
    smsBody:`${companyName}: your ${lead.Service} booking on ${when} is confirmed. Amount ${money(booking.Amount)}.`,
  };
}
export function verifyEmailMessage({companyName,link}){
  return {subject:`Verify your ${companyName} QuotePilot account`,body:[`Welcome to QuotePilot.`,'',`Confirm this email address to activate your ${companyName} workspace:`,'',link,'','This link expires in 24 hours. If you did not sign up, ignore this message.'].join('\n')};
}
export function resetEmailMessage({link}){
  return {subject:'Reset your QuotePilot password',body:['A password reset was requested for your QuotePilot account.','',link,'','This link expires in 1 hour. If you did not request it, ignore this message — your password is unchanged.'].join('\n')};
}
