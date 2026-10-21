import { GetObjectCommand,S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function createObjectStorage(config){if(!config.objectStorageConfigured){const error=new Error("Object storage is not configured");error.statusCode=503;error.code="OBJECT_STORAGE_NOT_CONFIGURED";throw error;}return new S3Client({endpoint:config.OBJECT_STORAGE_ENDPOINT,region:config.OBJECT_STORAGE_REGION,forcePathStyle:config.OBJECT_STORAGE_FORCE_PATH_STYLE,credentials:{accessKeyId:config.OBJECT_STORAGE_ACCESS_KEY_ID,secretAccessKey:config.OBJECT_STORAGE_SECRET_ACCESS_KEY}});}
export function codeExportObjectKey(tenantId,jobId){return`tenants/${tenantId}/code-jobs/${jobId}/codes.csv`;}
export async function presignCodeExport(storage,config,key,{expiresIn=300}={}){return getSignedUrl(storage,new GetObjectCommand({Bucket:config.OBJECT_STORAGE_BUCKET,Key:key,ResponseContentType:"text/csv; charset=utf-8",ResponseContentDisposition:'attachment; filename="reliacode-codes.csv"'}),{expiresIn});}
