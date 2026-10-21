import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordLoginAllowed } from '../src/password-login-policy.mjs';

test('platform and tenant administrators switch to Passkey-only login after two registrations',()=>{
  for(const role of ['PLATFORM_OPERATOR','TENANT_OWNER','BRAND_ADMIN','FINANCE']){
    assert.equal(passwordLoginAllowed({role,passkey_count:1}),true);
    assert.equal(passwordLoginAllowed({role,passkey_count:2}),false);
  }
});

test('operator password login follows tenant policy while read-only roles remain available',()=>{
  assert.equal(passwordLoginAllowed({role:'FACTORY_OPERATOR',password_login_for_operators:false}),false);
  assert.equal(passwordLoginAllowed({role:'STORE_RECEIVER',password_login_for_operators:true}),true);
  assert.equal(passwordLoginAllowed({role:'READ_ONLY_AUDITOR',password_login_for_operators:false}),true);
});
