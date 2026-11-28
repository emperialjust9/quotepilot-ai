// QuotePilot file uploads — validated, allowlisted, storage-abstracted.
//
// Validation is fail-closed and layered:
//   1. The declared content type AND the file extension must both be on the
//      allowlist and must agree with each other.
//   2. The size must be > 0 and <= the configured cap.
//   3. The content's magic bytes must match the declared type (binary
//      formats), and executable/script signatures are refused outright —
//      including for the text types, which must decode as plain text.
// Storage sits behind a two-method interface (put/get). MemoryUploadStore
// serves demo mode and tests; LocalUploadStore writes to a configured
// directory under generated names (the original filename is metadata only,
// never a filesystem path).
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {HttpError} from './validators.mjs';

export const UPLOAD_TYPES={
  'image/png':['.png'],
  'image/jpeg':['.jpg','.jpeg'],
  'image/gif':['.gif'],
  'image/webp':['.webp'],
  'application/pdf':['.pdf'],
  'text/plain':['.txt'],
  'text/csv':['.csv'],
};
export const DEFAULT_UPLOAD_MAX_BYTES=5*1024*1024;

function hasMagic(data,prefix){return data.length>=prefix.length&&prefix.every((b,i)=>data[i]===b);}
function looksExecutable(data){
  if(hasMagic(data,[0x4d,0x5a]))return true;                       // MZ (DOS/Windows exe)
  if(hasMagic(data,[0x7f,0x45,0x4c,0x46]))return true;             // ELF
  if(hasMagic(data,[0x23,0x21]))return true;                       // #! script
  if(hasMagic(data,[0xca,0xfe,0xba,0xbe]))return true;             // Mach-O / Java class
  return false;
}
function magicMatches(contentType,data){
  switch(contentType){
    case 'image/png':return hasMagic(data,[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    case 'image/jpeg':return hasMagic(data,[0xff,0xd8,0xff]);
    case 'image/gif':return data.subarray(0,4).toString('ascii')==='GIF8';
    case 'image/webp':return data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WEBP';
    case 'application/pdf':return data.subarray(0,4).toString('ascii')==='%PDF';
    case 'text/plain':
    case 'text/csv':{
      const text=data.toString('utf8');
      if(text.includes('\uFFFD'))return false;
      return !/^\s*<(html|script|!doctype)/i.test(text);
    }
    default:return false;
  }
}

export function validateUpload({filename,contentType,data,maxBytes=DEFAULT_UPLOAD_MAX_BYTES}){
  if(typeof filename!=='string'||!filename.trim()||filename.length>160)throw new HttpError(400,'A valid filename is required');
  const base=filename.split(/[\\/]/).pop();
  const ext=path.extname(base).toLowerCase();
  const type=String(contentType||'').split(';')[0].trim().toLowerCase();
  const extensions=UPLOAD_TYPES[type];
  if(!extensions)throw new HttpError(400,'File type is not allowed');
  if(!extensions.includes(ext))throw new HttpError(400,'File extension does not match its type');
  if(!Buffer.isBuffer(data)||data.length===0)throw new HttpError(400,'File is empty');
  if(data.length>maxBytes)throw new HttpError(413,'File exceeds the upload size limit');
  if(looksExecutable(data))throw new HttpError(400,'Executable or script content is not allowed');
  if(!magicMatches(type,data))throw new HttpError(400,'File content does not match its declared type');
  return {filename:base,contentType:type,ext,size:data.length};
}

export class MemoryUploadStore {
  constructor(){this.files=new Map();}
  async put(ref,data){this.files.set(ref,Buffer.from(data));return ref;}
  async get(ref){const data=this.files.get(ref);if(!data)throw new HttpError(404,'Stored file not found');return data;}
}

export class LocalUploadStore {
  constructor({dir}){if(!dir)throw new Error('Upload directory required');this.dir=dir;this.ready=null;}
  async ensure(){if(!this.ready)this.ready=mkdir(this.dir,{recursive:true});await this.ready;}
  refPath(ref){if(!/^[A-Za-z0-9._-]+$/.test(ref)||ref.includes('..'))throw new HttpError(400,'Invalid storage reference');return path.join(this.dir,ref);}
  async put(ref,data){await this.ensure();await writeFile(this.refPath(ref),data);return ref;}
  async get(ref){await this.ensure();const target=this.refPath(ref);try{return await readFile(target);}catch{throw new HttpError(404,'Stored file not found');}}
}

export function newUploadRef(ext){return `upl_${randomUUID().replace(/-/g,'')}${ext}`;}
