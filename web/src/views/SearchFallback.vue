<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NInput,
  NSelect,
  NSpace,
  NSpin,
  NSwitch,
  NTag,
  useMessage,
} from 'naive-ui';
import { api, type CommercialEngineEntry, type SearchFallbackState } from '../api.js';

/**
 * 搜索兜底设置页（商业引擎）。
 *
 * 三个区域：引擎列表管理（启停/上下移排序，本期不做拖拽）、Devin 登录卡片
 * （粘贴码 OAuth）、Brave API Key。全部 opt-in：列表为空 = 兜底整体关闭（默认）。
 */
const message = useMessage();
const loading = ref(true);
const savingEngines = ref(false);

/** 本地编辑态（保存前与服务端状态解耦） */
const engines = ref<CommercialEngineEntry[]>([]);
const catalog = ref<SearchFallbackState['catalog']>([]);
const braveConfigured = ref(false);

const devinStatus = computed(() => catalog.value.find((c) => c.id === 'devin')?.status);
/** 可加入列表的引擎（已在列表里的不重复出现） */
const addableEngines = computed(() =>
  catalog.value.filter((c) => !engines.value.some((e) => e.id === c.id)),
);
const addTarget = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    const s = await api<SearchFallbackState>('/settings/search-fallback');
    engines.value = s.engines.map((e) => ({ ...e }));
    catalog.value = s.catalog;
    braveConfigured.value = s.brave.configured;
  } catch (err) {
    message.error(err instanceof Error ? err.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function move(index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= engines.value.length) return;
  const list = engines.value;
  [list[index], list[target]] = [list[target], list[index]];
}

function addEngine() {
  const id = addTarget.value;
  if (!id) return;
  engines.value.push({ id, enabled: true });
  addTarget.value = null;
}

async function saveEngines() {
  savingEngines.value = true;
  try {
    const s = await api<SearchFallbackState>('/settings/search-fallback', {
      method: 'PUT',
      body: JSON.stringify({ engines: engines.value }),
    });
    engines.value = s.engines.map((e) => ({ ...e }));
    catalog.value = s.catalog;
    message.success('引擎列表已保存，即时生效');
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存失败');
  } finally {
    savingEngines.value = false;
  }
}

function engineName(id: string): string {
  return catalog.value.find((c) => c.id === id)?.name ?? id;
}

function statusTag(id: string): { label: string; type: 'default' | 'success' | 'warning' | 'error' } {
  const state = catalog.value.find((c) => c.id === id)?.status.state;
  switch (state) {
    case 'ok':
      return { label: '正常', type: 'success' };
    case 'expired':
      return { label: '凭证已过期', type: 'warning' };
    case 'invalid':
      return { label: '凭证失效（鉴权被拒，请重新配置）', type: 'error' };
    default:
      return { label: '未配置', type: 'default' };
  }
}

// ---- Devin 登录卡片 ----

const authUrl = ref<string | null>(null);
const loginPending = ref(false);
const code = ref('');
const exchanging = ref(false);

const devinStateText = computed(() => {
  const s = devinStatus.value;
  if (!s) return '';
  switch (s.state) {
    case 'ok':
      return `已登录（过期时间：${formatTime(s.expiresAt)}）`;
    case 'expired':
      return `凭证已过期（${formatTime(s.expiresAt)}），请重新登录`;
    case 'invalid':
      return '凭证失效（鉴权被拒已熔断），请重新登录';
    default:
      return '未登录';
  }
});

function formatTime(ms?: number): string {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '未知';
}

async function startLogin() {
  loginPending.value = true;
  try {
    const { url } = await api<{ url: string }>('/settings/search-fallback/devin-login', {
      method: 'POST',
    });
    authUrl.value = url;
    code.value = '';
    message.info('已生成授权链接，请在浏览器完成登录后把授权码粘贴回来');
  } catch (err) {
    message.error(err instanceof Error ? err.message : '发起登录失败');
  } finally {
    loginPending.value = false;
  }
}

async function exchange() {
  if (!code.value.trim()) {
    message.warning('请输入授权码');
    return;
  }
  exchanging.value = true;
  try {
    await api('/settings/search-fallback/devin-exchange', {
      method: 'POST',
      body: JSON.stringify({ code: code.value.trim() }),
    });
    message.success('Devin 登录成功');
    authUrl.value = null;
    code.value = '';
    await load();
  } catch (err) {
    message.error(err instanceof Error ? err.message : '授权码交换失败');
  } finally {
    exchanging.value = false;
  }
}

async function logoutDevin() {
  try {
    await api('/settings/search-fallback/devin-token', { method: 'DELETE' });
    message.success('已注销 Devin 登录');
    authUrl.value = null;
    await load();
  } catch (err) {
    message.error(err instanceof Error ? err.message : '注销失败');
  }
}

// ---- Brave API Key ----

const braveKey = ref('');
const savingBrave = ref(false);

async function saveBrave(clear = false) {
  const value = clear ? '' : braveKey.value.trim();
  if (!clear && !value) {
    message.warning('请输入 Brave Search API Key');
    return;
  }
  savingBrave.value = true;
  try {
    await api('/settings/search-fallback', {
      method: 'PUT',
      body: JSON.stringify({ braveApiKey: value }),
    });
    braveConfigured.value = !clear && Boolean(value);
    braveKey.value = '';
    message.success(clear ? 'Brave Key 已清除' : 'Brave Key 已保存');
  } catch (err) {
    message.error(err instanceof Error ? err.message : '保存失败');
  } finally {
    savingBrave.value = false;
  }
}

onMounted(load);
</script>

<template>
  <NSpin :show="loading">
    <NSpace vertical :size="16">
      <NCard title="搜索兜底引擎">
        <NSpace vertical :size="16">
          <NAlert type="info" :show-icon="true">
            SearXNG 降级链全部走空时，按此列表顺序尝试商业搜索引擎兜底；列表为空 = 兜底关闭（默认）。
            全部 opt-in：商业引擎消耗第三方账号额度，Devin 引擎为非官方用法（存在封号风险），公开实例建议保持关闭。
          </NAlert>

          <div v-if="engines.length === 0" class="empty-hint">
            尚未配置任何兜底引擎。从下方选择引擎加入列表。
          </div>

          <div v-for="(engine, index) in engines" :key="engine.id" class="engine-row">
            <span class="engine-name">{{ engineName(engine.id) }}</span>
            <NTag :type="statusTag(engine.id).type" size="small" :bordered="false">
              {{ statusTag(engine.id).label }}
            </NTag>
            <div class="spacer" />
            <NSwitch v-model:value="engine.enabled" size="small" />
            <NButton
              size="tiny"
              quaternary
              :disabled="index === 0"
              @click="move(index, -1)"
            >
              上移
            </NButton>
            <NButton
              size="tiny"
              quaternary
              :disabled="index === engines.length - 1"
              @click="move(index, 1)"
            >
              下移
            </NButton>
            <NButton
              size="tiny"
              quaternary
              type="error"
              @click="engines.splice(index, 1)"
            >
              移除
            </NButton>
          </div>

          <NSpace v-if="addableEngines.length > 0" align="center">
            <NSelect
              v-model:value="addTarget"
              :options="addableEngines.map((e) => ({ label: e.name, value: e.id }))"
              placeholder="选择要加入的引擎"
              size="small"
              style="width: 220px"
            />
            <NButton size="small" :disabled="!addTarget" @click="addEngine">加入</NButton>
          </NSpace>

          <NSpace>
            <NButton type="primary" :loading="savingEngines" @click="saveEngines">保存列表</NButton>
          </NSpace>
        </NSpace>
      </NCard>

      <NCard title="Devin 登录（Exa 商业搜索）">
        <NSpace vertical :size="16">
          <NSpace align="center">
            <span>当前状态：{{ devinStateText || '未知（引擎未注册）' }}</span>
            <NButton v-if="devinStatus && devinStatus.state !== 'not_configured'" size="small" quaternary type="error" @click="logoutDevin">
              注销
            </NButton>
          </NSpace>

          <template v-if="!authUrl">
            <NButton type="primary" :loading="loginPending" @click="startLogin">登录 Devin</NButton>
          </template>
          <template v-else>
            <NAlert type="warning" :show-icon="true">
              <p>1. 打开授权链接并登录 Devin 账号（有效期 10 分钟，过期请重新发起）：</p>
              <a :href="authUrl" target="_blank" rel="noopener" class="auth-link">{{ authUrl }}</a>
              <p>2. 登录后会显示一次性授权码，把它粘贴到下方输入框提交。</p>
            </NAlert>
            <NSpace align="center">
              <NInput
                v-model:value="code"
                placeholder="粘贴 Devin 授权码"
                style="width: 360px"
                @keyup.enter="exchange"
              />
              <NButton type="primary" :loading="exchanging" @click="exchange">提交授权码</NButton>
            </NSpace>
          </template>
        </NSpace>
      </NCard>

      <NCard title="Brave Search API Key">
        <NSpace vertical :size="12">
          <span class="hint">
            {{ braveConfigured ? '已配置（出于安全不回显，输入新值可覆盖）' : '未配置' }}。
            免费额度 2000 次/月，在
            <a href="https://api-dashboard.search.brave.com/" target="_blank" rel="noopener">Brave API Dashboard</a>
            申请。保存后把 Brave 加入引擎列表即可参与兜底。
          </span>
          <NSpace align="center">
            <NInput
              v-model:value="braveKey"
              type="password"
              show-password-on="click"
              placeholder="Brave Search API Key"
              style="width: 360px"
            />
            <NButton type="primary" :loading="savingBrave" @click="saveBrave(false)">保存</NButton>
            <NButton v-if="braveConfigured" quaternary type="error" :loading="savingBrave" @click="saveBrave(true)">
              清除
            </NButton>
          </NSpace>
        </NSpace>
      </NCard>
    </NSpace>
  </NSpin>
</template>

<style scoped>
.engine-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--n-border-color);
}
.engine-name {
  min-width: 120px;
  font-weight: 500;
}
.spacer {
  flex: 1;
}
.empty-hint {
  color: #999;
  font-size: 13px;
}
.hint {
  font-size: 13px;
  color: #666;
}
.auth-link {
  word-break: break-all;
  display: inline-block;
  margin: 4px 0;
}
</style>
