import { hash, jsonBytes } from '../../src/build-cache/paths.mjs';
import { previewStorageBytes, previewStorageWorkerSha256 } from '../../src/preview/storage.mjs';

export function previewStorageFixture(project, engineId='engine-fixture', root='/var/lib/fogd-preview-storage-fixture') {
 const dir=root+'/'+project,id=project.slice(13),uuid=[id.slice(0,8),id.slice(8,12),id.slice(12,16),id.slice(16,20),id.slice(20)].join('-');
 const roles=['minio','slot-1-a','slot-1-b','slot-2-a','slot-2-b','controller','controller-trust','controller-input','gateway-trust','gateway-input','ingress-trust','ingress-input'];
 const storage={schema:1,kind:'fogd-preview-storage',project,engineId,uuid,bytes:previewStorageBytes,rootIdentity:{device:1,inode:1},directoryIdentity:{device:1,inode:2},disk:{device:1,inode:3,bytes:previewStorageBytes,allocatedBytes:previewStorageBytes},mount:{target:dir+'/mount',source:'/dev/loop3',fstype:'ext4',uuid,options:'rw,nosuid,nodev,noexec,relatime',fsroot:'/', 'maj:min':'7:3'},loop:{name:'/dev/loop3','back-file':dir+'/disk.img','back-ino':3,'back-maj:min':'0:1','maj:min':'7:3',ro:false,autoclear:false,offset:0,sizelimit:0},roles:Object.fromEntries(roles.map((r,i)=>[r,{device:2,inode:i+1}]))};
 return{storage,sha256:hash(jsonBytes(storage)),workerSha256:previewStorageWorkerSha256,resourcesRetained:true,executionAuthorized:false,ordinaryEnrollment:false};
}
export const previewStorageHostFixture = receipt => async()=>JSON.stringify({ok:true,storage:receipt.storage});
