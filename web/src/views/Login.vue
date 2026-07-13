<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { NCard, NForm, NFormItem, NInput, NButton, useMessage, NSpace } from 'naive-ui';
import { api } from '../api.js';

const router = useRouter();
const message = useMessage();

const password = ref('');
const loading = ref(false);

async function handleLogin() {
  if (!password.value) {
    message.warning('请输入密码');
    return;
  }
  loading.value = true;
  try {
    await api('/login', {
      method: 'POST',
      body: JSON.stringify({ password: password.value }),
    });
    message.success('登录成功');
    router.push('/');
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-container">
    <NCard class="login-card" title="linkseek 管理后台">
      <NForm @keyup.enter="handleLogin">
        <NFormItem label="管理员密码">
          <NInput
            v-model:value="password"
            type="password"
            show-password-on="click"
            placeholder="请输入密码"
          />
        </NFormItem>
        <NSpace justify="end">
          <NButton type="primary" :loading="loading" @click="handleLogin">
            登录
          </NButton>
        </NSpace>
      </NForm>
    </NCard>
  </div>
</template>

<style scoped>
.login-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: #f5f5f5;
}
.login-card {
  width: 400px;
  max-width: 90vw;
}
</style>
