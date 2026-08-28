import { z } from "zod";
import { ACCOUNT_TOKEN_PURPOSE,createAccountRecoveryService } from "./auth-recovery.mjs";
import { createPostgresRecoveryStore } from "./auth-recovery-store.mjs";
import { createEmailDelivery } from "./email-delivery.mjs";

const email=z.string().trim().email().max(254),token=z.string().min(32).max(256),password=z.string().min(12).max(1024);
function service(db){return createAccountRecoveryService({store:createPostgresRecoveryStore(db)});}
export function registerRecoveryRoutes(app,{db,config,emailDeliveryFactory=createEmailDelivery}){
  app.post("/api/auth/password-reset/request",{config:{rateLimit:{max:10,timeWindow:"1 hour"}}},async(request,reply)=>{const body=z.object({email}).parse(request.body);if(!config.emailDeliveryConfigured)throw Object.assign(new Error("Email recovery is unavailable"),{statusCode:503,code:"EMAIL_NOT_CONFIGURED"});const issued=await service(db).requestPasswordReset(body.email,{generic:true});if(issued.delivered){const delivery=emailDeliveryFactory(config);try{await delivery.sendAccountLink({to:issued.email,purpose:ACCOUNT_TOKEN_PURPOSE.PASSWORD_RESET,token:issued.token});}catch(error){request.log.error({err:error},"password recovery email failed");}finally{delivery.close();}}return reply.code(202).send({accepted:true,message:"If the verified address exists, a recovery email will be sent"});});
  app.post("/api/auth/password-reset/confirm",{config:{rateLimit:{max:10,timeWindow:"15 minutes"}}},async(request)=>{const body=z.object({token,newPassword:password}).parse(request.body);await service(db).confirmPasswordReset(body.token,body.newPassword);return{updated:true};});
  app.post("/api/auth/email-verification/request",{config:{rateLimit:{max:5,timeWindow:"1 hour"}}},async(request,reply)=>{if(!config.emailDeliveryConfigured)throw Object.assign(new Error("Email verification is unavailable"),{statusCode:503,code:"EMAIL_NOT_CONFIGURED"});const issued=await service(db).requestEmailVerification(request.principal.email,{generic:false});if(issued.delivered){const delivery=emailDeliveryFactory(config);try{await delivery.sendAccountLink({to:issued.email,purpose:ACCOUNT_TOKEN_PURPOSE.EMAIL_VERIFICATION,token:issued.token});}finally{delivery.close();}}return reply.code(202).send({accepted:true});});
  app.post("/api/auth/email-verification/confirm",{config:{rateLimit:{max:10,timeWindow:"15 minutes"}}},async(request)=>{const body=z.object({token}).parse(request.body);await service(db).confirmEmailVerification(body.token);return{verified:true};});
}
