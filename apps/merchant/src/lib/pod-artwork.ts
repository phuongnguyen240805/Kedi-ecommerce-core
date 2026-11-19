const crcTable=Uint32Array.from({length:256},(_,index)=>{let c=index;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
/** Validate bounded PNG structure without expanding untrusted compressed pixels. Print quality still requires review. */
export function inspectPodPng(bytes:Uint8Array){
 if(bytes.length<57||bytes.length>20_000_000||![137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b))throw Error('Invalid PNG');
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=8,width=0,height=0,idat=false,end=false;
 while(offset<bytes.length){
  if(offset+12>bytes.length)throw Error('Truncated PNG');
  const length=view.getUint32(offset),limit=offset+12+length;if(limit>bytes.length)throw Error('Truncated PNG chunk');
  const name=new TextDecoder().decode(bytes.subarray(offset+4,offset+8));let crc=0xffffffff;
  for(let i=offset+4;i<offset+8+length;i++)crc=crcTable[(crc^bytes[i])&255]^(crc>>>8);
  if(((crc^0xffffffff)>>>0)!==view.getUint32(offset+8+length))throw Error('PNG checksum failed');
  if(offset===8){
   if(name!=='IHDR'||length!==13)throw Error('PNG header missing');width=view.getUint32(offset+8);height=view.getUint32(offset+12);
   if(width<100||height<100||width>15000||height>15000)throw Error('Unsupported print dimensions');
  }else if(name==='IHDR')throw Error('Duplicate PNG header');
  if(name==='IDAT')idat=true;
  if(name==='IEND'){if(length!==0||limit!==bytes.length)throw Error('Invalid PNG end');end=true;}
  offset=limit;
 }
 if(!idat||!end)throw Error('Incomplete PNG');return {width,height};
}
