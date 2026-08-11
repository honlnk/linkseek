<script setup lang="ts">
import { ref, h, onMounted } from 'vue';
import {
  NCard,
  NDataTable,
  NButton,
  NSpace,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NTag,
  NPopconfirm,
  NSwitch,
  NAlert,
  NEmpty,
  NDivider,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { api, type LlmProviderItem, type LlmProviderList, type Protocol, type ProviderPricing } from '../api.js';

const message = useMessage();

const providers = ref<LlmProviderItem[]>([]);
const defaultId = ref<string | null>(null);
const loading = ref(false);

// 协议选项（带默认 baseUrl）
const protocolOptions = [
  { label: 'OpenAI 兼容', value: 'openai' as Protocol, baseUrl: 'https://api.openai.com/v1' },
  { label: 'OpenAI Responses', value: 'openai-responses' as Protocol, baseUrl: 'https://api.openai.com/v1' },
  { label: 'Anthropic', value: 'anthropic' as Protocol, baseUrl: 'https://api.anthropic.com' },
  { label: 'Gemini', value: 'gemini' as Protocol, baseUrl: 'https://generativelanguage.googleapis.com' },
];

const protocolLabels: Record<Protocol, string> = {
  openai: 'OpenAI 兼容',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

const protocolColors: Record<Protocol, string> = {
  openai: 'success',
  'openai-responses': 'info',
  anthropic: 'warning',
  gemini: 'error',
};

// 新建/编辑弹窗
const showForm = ref(false);
const isEdit = ref(false);
const editingId = ref('');

/** 价格配置默认值（全 0，依赖 normalizePricing 兜底；用户填或查价后覆盖） */
function defaultPricing(): ProviderPricing {
  return {
    inputPerMTok: 0,
    outputPerMTok: 0,
    cacheHitEnabled: true,
    cacheHitPerMTok: 0,
    cacheWriteEnabled: false,
    cacheWritePerMTok: 0,
  };
}

const form = ref({
  name: '',
  protocol: 'openai' as Protocol,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  ...defaultPricing(),
});
const saving = ref(false);

// 模型列表
const modelOptions = ref<string[]>([]);
const fetchingModels = ref(false);
// 查价 loading
const pricingLoading = ref(false);

async function loadProviders() {
  loading.value = true;
  try {
    const data = await api<LlmProviderList>('/llm-providers');
    providers.value = data.providers;
    defaultId.value = data.defaultId;
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  isEdit.value = false;
  editingId.value = '';
  form.value = {
    name: '',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    ...defaultPricing(),
  };
  modelOptions.value = [];
  showForm.value = true;
}

function openEdit(row: LlmProviderItem) {
  isEdit.value = true;
  editingId.value = row.id;
  form.value = {
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    apiKey: '', // 编辑时留空 = 不改
    model: row.model,
    ...row.pricing,
  };
  modelOptions.value = row.models;
  showForm.value = true;
}

function onProtocolChange(val: Protocol) {
  // 如果 baseUrl 还是默认值，自动切换到新协议的默认值
  const oldDefault = protocolOptions.find((p) => p.value === form.value.protocol)?.baseUrl;
  if (oldDefault && form.value.baseUrl === oldDefault) {
    const newDefault = protocolOptions.find((p) => p.value === val)?.baseUrl;
    if (newDefault) form.value.baseUrl = newDefault;
  }
}

async function handleFetchModels() {
  if (!form.value.baseUrl.trim() || !form.value.apiKey.trim()) {
    message.warning('请先填写 Base URL 和 API Key');
    return;
  }
  fetchingModels.value = true;
  try {
    let resp;
    if (isEdit.value && editingId.value) {
      // 已保存的 Provider：用 ID 拉取
      resp = await api<{ models: string[] }>(`/llm-providers/${editingId.value}/models`, {
        method: 'POST',
      });
    } else {
      // 新建：用临时凭据拉取
      resp = await api<{ models: string[] }>('/llm-providers/models', {
        method: 'POST',
        body: JSON.stringify({
          baseUrl: form.value.baseUrl,
          apiKey: form.value.apiKey,
          protocol: form.value.protocol,
        }),
      });
    }
    modelOptions.value = resp.models;
    if (resp.models.length === 0) {
      message.info('拉取到的模型列表为空');
    } else if (!form.value.model) {
      // 自动选第一个
      form.value.model = resp.models[0];
    }
    message.success(`获取到 ${resp.models.length} 个模型`);
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    fetchingModels.value = false;
  }
}

/** 从 OpenRouter 查询模型参考价并填入表单（查不到静默跳过） */
async function handleFetchPricing() {
  if (!form.value.model.trim()) {
    message.warning('请先填写或选择模型');
    return;
  }
  pricingLoading.value = true;
  try {
    const resp = await api<{ found?: boolean; pricing?: Partial<ProviderPricing> & { hasCacheHit?: boolean; hasCacheWrite?: boolean }; currency?: string }>(`/pricing/${encodeURIComponent(form.value.model.trim())}`);
    if (!resp.found || !resp.pricing) {
      message.info('OpenRouter 未查到该模型价格，请手动填写');
      return;
    }
    const p = resp.pricing;
    if (typeof p.inputPerMTok === 'number') form.value.inputPerMTok = p.inputPerMTok;
    if (typeof p.outputPerMTok === 'number') form.value.outputPerMTok = p.outputPerMTok;
    if (p.hasCacheHit) {
      form.value.cacheHitEnabled = true;
      if (typeof p.cacheHitPerMTok === 'number') form.value.cacheHitPerMTok = p.cacheHitPerMTok;
    }
    if (p.hasCacheWrite) {
      form.value.cacheWriteEnabled = true;
      if (typeof p.cacheWritePerMTok === 'number') form.value.cacheWritePerMTok = p.cacheWritePerMTok;
    }
    message.success(`已填入参考价（${resp.currency ?? 'USD'}，来自 OpenRouter）`);
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    pricingLoading.value = false;
  }
}

async function handleSave() {
  if (!form.value.name.trim()) {
    message.warning('请输入名称');
    return;
  }
  if (!form.value.baseUrl.trim()) {
    message.warning('请输入 Base URL');
    return;
  }
  if (!isEdit.value && !form.value.apiKey.trim()) {
    message.warning('请输入 API Key');
    return;
  }
  if (!form.value.model.trim()) {
    message.warning('请输入或选择模型');
    return;
  }

  saving.value = true;
  try {
    // 组装价格配置
    const pricing: ProviderPricing = {
      inputPerMTok: form.value.inputPerMTok,
      outputPerMTok: form.value.outputPerMTok,
      cacheHitEnabled: form.value.cacheHitEnabled,
      cacheHitPerMTok: form.value.cacheHitPerMTok,
      cacheWriteEnabled: form.value.cacheWriteEnabled,
      cacheWritePerMTok: form.value.cacheWritePerMTok,
    };
    if (isEdit.value) {
      const body: Record<string, unknown> = {
        name: form.value.name,
        protocol: form.value.protocol,
        baseUrl: form.value.baseUrl,
        model: form.value.model,
        pricing,
      };
      if (form.value.apiKey.trim()) body.apiKey = form.value.apiKey;
      await api(`/llm-providers/${editingId.value}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      message.success('已更新');
    } else {
      await api('/llm-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: form.value.name,
          protocol: form.value.protocol,
          baseUrl: form.value.baseUrl,
          apiKey: form.value.apiKey,
          model: form.value.model,
          pricing,
        }),
      });
      message.success('已创建');
    }
    showForm.value = false;
    await loadProviders();
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    saving.value = false;
  }
}

async function handleToggle(row: LlmProviderItem, enabled: boolean) {
  try {
    await api(`/llm-providers/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    row.enabled = enabled;
    message.success(enabled ? '已启用' : '已禁用');
  } catch (err) {
    message.error((err as Error).message);
    row.enabled = !enabled;
  }
}

async function handleSetDefault(row: LlmProviderItem) {
  try {
    await api(`/llm-providers/default/${row.id}`, { method: 'PUT' });
    message.success(`已设「${row.name}」为默认`);
    await loadProviders();
  } catch (err) {
    message.error((err as Error).message);
  }
}

async function handleDelete(row: LlmProviderItem) {
  try {
    await api(`/llm-providers/${row.id}`, { method: 'DELETE' });
    message.success('已删除');
    await loadProviders();
  } catch (err) {
    message.error((err as Error).message);
  }
}

const columns: DataTableColumns<LlmProviderItem> = [
  { title: '名称', key: 'name' },
  {
    title: '协议',
    key: 'protocol',
    render: (row) =>
      h(NTag, { type: protocolColors[row.protocol] as 'success', size: 'small' }, () =>
        protocolLabels[row.protocol],
      ),
  },
  { title: 'Base URL', key: 'baseUrl', ellipsis: { tooltip: true } },
  { title: '模型', key: 'model' },
  {
    title: '默认',
    key: 'isDefault',
    render: (row) =>
      row.isDefault
        ? h(NTag, { type: 'info', size: 'small' }, () => '默认')
        : h(
            NButton,
            { size: 'small', quaternary: true, onClick: () => handleSetDefault(row) },
            () => '设为默认',
          ),
  },
  {
    title: '状态',
    key: 'enabled',
    render(row) {
      return h(NSwitch, {
        value: row.enabled,
        onUpdateValue: (v: boolean) => handleToggle(row, v),
      });
    },
  },
  {
    title: 'API Key',
    key: 'apiKeyMasked',
    render: (row) => h('code', { style: 'font-size: 12px; color: #999' }, row.apiKeyMasked),
  },
  {
    title: '操作',
    key: 'actions',
    render(row) {
      const buttons = [
        h(
          NButton,
          { size: 'small', quaternary: true, onClick: () => openEdit(row) },
          () => '编辑',
        ),
      ];
      if (!row.isDefault) {
        buttons.push(
          h(
            NPopconfirm,
            { onPositiveClick: () => handleDelete(row) },
            {
              default: () => `确认删除「${row.name}」？`,
              trigger: () =>
                h(NButton, { size: 'small', type: 'error', quaternary: true }, () => '删除'),
            },
          ),
        );
      }
      return h(NSpace, { size: 'small' }, () => buttons);
    },
  },
];

onMounted(loadProviders);
</script>

<template>
  <NSpace vertical :size="16">
    <NSpace justify="space-between" align="center">
      <h2 style="margin: 0">AI 模型配置</h2>
      <NButton type="primary" @click="openCreate">新增 Provider</NButton>
    </NSpace>

    <NCard>
      <NEmpty v-if="providers.length === 0 && !loading" description="尚未配置任何 AI 模型">
        <template #extra>
          <NButton type="primary" @click="openCreate">立即配置</NButton>
        </template>
      </NEmpty>
      <NDataTable
        v-else
        :columns="columns"
        :data="providers"
        :loading="loading"
        :bordered="false"
      />
    </NCard>

    <!-- 新建/编辑 Provider 弹窗 -->
    <NModal v-model:show="showForm" :title="isEdit ? '编辑 Provider' : '新增 Provider'" preset="dialog" style="width: 600px">
      <NForm label-placement="top">
        <NFormItem label="名称">
          <NInput v-model:value="form.name" placeholder="如：DeepSeek 主力" />
        </NFormItem>
        <NFormItem label="API 协议">
          <NSelect
            v-model:value="form.protocol"
            :options="protocolOptions.map((p) => ({ label: p.label, value: p.value }))"
            @update:value="onProtocolChange"
          />
        </NFormItem>
        <NFormItem label="Base URL">
          <NInput v-model:value="form.baseUrl" placeholder="https://api.deepseek.com/v1" />
        </NFormItem>
        <NFormItem :label="isEdit ? 'API Key（留空 = 不修改）' : 'API Key'">
          <NInput
            v-model:value="form.apiKey"
            type="password"
            show-password-on="click"
            :placeholder="isEdit ? '***（不修改请留空）' : 'sk-...'"
          />
        </NFormItem>
        <NFormItem label="模型">
          <NSpace align="center" style="width: 100%">
            <NInput
              v-model:value="form.model"
              placeholder="模型名或从列表选择"
              style="flex: 1"
              list="model-list"
            />
            <datalist v-if="modelOptions.length > 0" id="model-list">
              <option v-for="m in modelOptions" :key="m" :value="m" />
            </datalist>
            <NButton :loading="fetchingModels" @click="handleFetchModels">
              获取列表
            </NButton>
          </NSpace>
        </NFormItem>

        <NDivider style="margin: 12px 0">价格配置（用于成本统计，单位：/百万 token）</NDivider>
        <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 12px">
          <NButton size="small" :loading="pricingLoading" :disabled="!form.model.trim()" @click="handleFetchPricing">
            从 OpenRouter 查价
          </NButton>
          <span style="font-size: 12px; color: #999">参考价，请按实际核对</span>
        </div>
        <div style="display: flex; gap: 16px">
          <NFormItem label="输入（未命中）单价" style="flex: 1">
            <NInputNumber v-model:value="form.inputPerMTok" :precision="4" :step="0.01" :min="0" style="width: 100%" />
          </NFormItem>
          <NFormItem label="输出单价" style="flex: 1">
            <NInputNumber v-model:value="form.outputPerMTok" :precision="4" :step="0.01" :min="0" style="width: 100%" />
          </NFormItem>
        </div>
        <NFormItem label="启用缓存命中价格">
          <NSwitch v-model:value="form.cacheHitEnabled" />
          <span style="margin-left: 8px; font-size: 12px; color: #999">多数 Provider 支持命中按低价计费</span>
        </NFormItem>
        <NFormItem v-if="form.cacheHitEnabled" label="缓存命中单价">
          <NInputNumber v-model:value="form.cacheHitPerMTok" :precision="4" :step="0.001" :min="0" style="width: 100%" />
        </NFormItem>
        <NFormItem label="启用缓存写入价格">
          <NSwitch v-model:value="form.cacheWriteEnabled" />
          <span style="margin-left: 8px; font-size: 12px; color: #999">仅 Anthropic 等少数模型</span>
        </NFormItem>
        <NFormItem v-if="form.cacheWriteEnabled" label="缓存写入单价">
          <NInputNumber v-model:value="form.cacheWritePerMTok" :precision="4" :step="0.01" :min="0" style="width: 100%" />
        </NFormItem>

        <NAlert v-if="modelOptions.length > 0" type="info" :show-icon="false" style="margin-top: 8px">
          可用模型（共 {{ modelOptions.length }} 个）：{{ modelOptions.slice(0, 10).join(', ') }}{{ modelOptions.length > 10 ? '...' : '' }}
        </NAlert>
      </NForm>
      <template #action>
        <NSpace>
          <NButton @click="showForm = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="handleSave">
            {{ isEdit ? '保存' : '创建' }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </NSpace>
</template>
