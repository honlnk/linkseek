<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  NCard,
  NForm,
  NFormItem,
  NInputNumber,
  NButton,
  NSpace,
  NSpin,
  NAlert,
  useMessage,
} from 'naive-ui';
import { api, type TaskSettings } from '../api.js';

const message = useMessage();
const loading = ref(true);
const saving = ref(false);
const perKey = ref<number | null>(3);
const global = ref<number | null>(10);
const defaults = ref<{ perKey: number; global: number }>({ perKey: 3, global: 10 });

async function load() {
  loading.value = true;
  try {
    const s = await api<TaskSettings>('/settings/tasks');
    perKey.value = s.perKey;
    global.value = s.global;
    if (s.defaults) defaults.value = s.defaults;
  } catch (err) {
    message.error(err instanceof Error ? err.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (perKey.value === null || global.value === null) {
    message.warning('并发上限不能为空');
    return;
  }
  saving.value = true;
  try {
    const s = await api<TaskSettings>('/settings/tasks', {
      method: 'PUT',
      body: JSON.stringify({ perKey: perKey.value, global: global.value }),
    });
    perKey.value = s.perKey;
    global.value = s.global;
    message.success('已保存，即时生效');
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <NSpin :show="loading">
    <NSpace vertical :size="16">
      <NCard title="任务并发设置">
        <NSpace vertical :size="16">
          <NAlert type="info" :show-icon="true">
            异步任务（defer 脱手 / web_research）的执行并发上限。按服务器性能调整：调高吞吐但更耗资源（CPU / 浏览器实例 / LLM 并发）。保存后即时生效，无需重启，重启后配置保留。
          </NAlert>
          <NForm label-placement="left" label-width="140" :show-feedback="false">
            <NFormItem label="每 Key 并发上限">
              <NInputNumber
                v-model:value="perKey"
                :min="1"
                :max="1000"
                :placeholder="String(defaults.perKey)"
                style="width: 200px"
              />
              <span class="hint">默认 {{ defaults.perKey }}：单个 Key 同时执行的任务数，超出排队</span>
            </NFormItem>
            <NFormItem label="全局并发上限" style="margin-top: 16px">
              <NInputNumber
                v-model:value="global"
                :min="1"
                :max="1000"
                :placeholder="String(defaults.global)"
                style="width: 200px"
              />
              <span class="hint">默认 {{ defaults.global }}：全部 Key 合计同时执行的任务数</span>
            </NFormItem>
          </NForm>
          <NSpace>
            <NButton type="primary" :loading="saving" @click="save">保存</NButton>
          </NSpace>
        </NSpace>
      </NCard>
    </NSpace>
  </NSpin>
</template>

<style scoped>
.hint {
  margin-left: 12px;
  font-size: 12px;
  color: #999;
}
</style>
