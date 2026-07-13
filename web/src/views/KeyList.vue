<script setup lang="ts">
import { ref, h, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  NCard,
  NDataTable,
  NButton,
  NSpace,
  NModal,
  NForm,
  NFormItem,
  NInput,
  NTag,
  NPopconfirm,
  NSwitch,
  NAlert,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import { api, type ApiKeyItem } from '../api.js';

const router = useRouter();
const message = useMessage();

const keys = ref<ApiKeyItem[]>([]);
const loading = ref(false);

// 新建弹窗
const showCreate = ref(false);
const newName = ref('');
const creating = ref(false);
// 新创建的 key 明文（仅展示一次）
const createdKey = ref<string | null>(null);
const showCreated = ref(false);

async function loadKeys() {
  loading.value = true;
  try {
    const data = await api<{ keys: ApiKeyItem[] }>('/keys');
    keys.value = data.keys;
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

async function handleCreate() {
  if (!newName.value.trim()) {
    message.warning('请输入 Key 名称');
    return;
  }
  creating.value = true;
  try {
    const result = await api<{ key: string; id: string }>('/keys', {
      method: 'POST',
      body: JSON.stringify({ name: newName.value }),
    });
    createdKey.value = result.key;
    showCreated.value = true;
    showCreate.value = false;
    newName.value = '';
    await loadKeys();
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    creating.value = false;
  }
}

async function handleToggle(row: ApiKeyItem, enabled: boolean) {
  try {
    await api(`/keys/${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    row.enabled = enabled;
    message.success(enabled ? '已启用' : '已禁用');
  } catch (err) {
    message.error((err as Error).message);
    // 恢复开关
    row.enabled = !enabled;
  }
}

async function handleDelete(row: ApiKeyItem) {
  try {
    await api(`/keys/${row.id}`, { method: 'DELETE' });
    message.success('已删除');
    await loadKeys();
  } catch (err) {
    message.error((err as Error).message);
  }
}

async function copyKey() {
  if (!createdKey.value) return;
  try {
    await navigator.clipboard.writeText(createdKey.value);
    message.success('已复制到剪贴板');
  } catch {
    message.error('复制失败，请手动选择复制');
  }
}

const columns: DataTableColumns<ApiKeyItem> = [
  {
    title: '名称',
    key: 'name',
    render(row) {
      return h(
        'a',
        {
          style: 'color: inherit; text-decoration: none',
          onClick: () => router.push({ name: 'key-detail', params: { id: row.id } }),
        },
        row.name,
      );
    },
  },
  { title: 'Key 前缀', key: 'tokenPrefix', render: (row) => `${row.tokenPrefix}...` },
  {
    title: '用量',
    key: 'usages',
    render: (row) => String(row._count?.usages ?? 0),
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
    title: '创建时间',
    key: 'createdAt',
    render: (row) => new Date(row.createdAt).toLocaleString('zh-CN'),
  },
  {
    title: '操作',
    key: 'actions',
    render(row) {
      return h(NPopconfirm, {
        onPositiveClick: () => handleDelete(row),
      }, {
        default: () => `确认删除「${row.name}」？此操作不可撤销，关联的用量记录也会删除。`,
        trigger: () => h(NButton, { size: 'small', type: 'error', quaternary: true }, () => '删除'),
      });
    },
  },
];

onMounted(loadKeys);
</script>

<template>
  <NSpace vertical :size="16">
    <NSpace justify="space-between" align="center">
      <h2 style="margin: 0">Key 管理</h2>
      <NButton type="primary" @click="showCreate = true">新建 Key</NButton>
    </NSpace>

    <NCard>
      <NDataTable
        :columns="columns"
        :data="keys"
        :loading="loading"
        :bordered="false"
      />
    </NCard>

    <!-- 新建 Key 弹窗 -->
    <NModal v-model:show="showCreate" title="新建 API Key" preset="dialog">
      <NForm>
        <NFormItem label="名称">
          <NInput
            v-model:value="newName"
            placeholder="如：我的 Claude Code"
            @keyup.enter="handleCreate"
          />
        </NFormItem>
      </NForm>
      <template #action>
        <NSpace>
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="handleCreate">创建</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 新创建的 Key 明文展示（仅一次） -->
    <NModal
      v-model:show="showCreated"
      title="Key 已创建"
      preset="dialog"
      :show-icon="false"
      :mask-closable="false"
      :close-on-esc="false"
    >
      <NAlert type="warning" style="margin-bottom: 12px">
        请立即复制保存！此明文 Key 仅显示一次，关闭后将无法再次获取。
      </NAlert>
      <NInput
        :value="createdKey ?? ''"
        readonly
        type="textarea"
        :rows="2"
        style="font-family: monospace"
      />
      <NSpace justify="end" style="margin-top: 12px">
        <NButton type="primary" @click="copyKey">
          复制到剪贴板
        </NButton>
        <NButton @click="showCreated = false">我已保存</NButton>
      </NSpace>
    </NModal>
  </NSpace>
</template>
