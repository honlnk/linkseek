<script setup lang="ts">
import { ref, h, type Component } from 'vue';
import { useRouter, RouterView, type RouterLink } from 'vue-router';
import {
  NLayout,
  NLayoutHeader,
  NLayoutContent,
  NLayoutSider,
  NMenu,
  NButton,
  NSpace,
  NIcon,
} from 'naive-ui';
import type { MenuOption } from 'naive-ui';

const router = useRouter();
const collapsed = ref(false);

/** 内联 SVG 图标组件（零依赖，避免引入 @vicons 整个包） */
function svgIcon(paths: string): Component {
  return {
    render: () =>
      h(NIcon, null, {
        default: () =>
          h(
            'svg',
            { viewBox: '0 0 24 24', width: '1em', height: '1em', fill: 'currentColor' },
            [h('path', { d: paths })],
          ),
      }),
  };
}

// 图标路径（Material Design Icons）
const DashboardIcon = svgIcon(
  'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
);
const KeyIcon = svgIcon(
  'M21 10h-8.35A5.99 5.99 0 0 0 7 6a6 6 0 1 0 5.65 8H13l2 2 2-2 2 2 2-2v-2l2-1.5V10zM7 15a2 2 0 1 1 0-4 2 2 0 0 1 0 4z',
);
const AiIcon = svgIcon(
  'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
);
const SettingsIcon = svgIcon(
  'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
);

const menuOptions: MenuOption[] = [
  { label: '请求总览', key: 'dashboard', icon: () => h(DashboardIcon) },
  { label: 'Key 管理', key: 'keys', icon: () => h(KeyIcon) },
  { label: 'AI 模型', key: 'llm-providers', icon: () => h(AiIcon) },
  { label: '任务设置', key: 'task-settings', icon: () => h(SettingsIcon) },
];

function handleMenu(key: string) {
  router.push({ name: key });
}

async function handleLogout() {
  await fetch('/api/logout', { method: 'POST' });
  router.push({ name: 'login' });
}
</script>

<template>
  <NLayout has-sider style="height: 100vh">
    <NLayoutSider
      bordered
      collapse-mode="width"
      :collapsed-width="64"
      :width="200"
      :collapsed="collapsed"
      show-trigger
      @collapse="collapsed = true"
      @expand="collapsed = false"
    >
      <div class="logo">
        <img src="/assets/brand/logo-mark.svg" alt="linkseek" />
        <span v-if="!collapsed">linkseek</span>
      </div>
      <NMenu
        :collapsed="collapsed"
        :collapsed-width="64"
        :collapsed-icon-size="22"
        :options="menuOptions"
        :value="String(router.currentRoute.value.name)"
        @update:value="handleMenu"
      />
    </NLayoutSider>
    <NLayout>
      <NLayoutHeader bordered class="header">
        <NSpace justify="end">
          <NButton quaternary @click="handleLogout">退出登录</NButton>
        </NSpace>
      </NLayoutHeader>
      <NLayoutContent class="content">
        <RouterView />
      </NLayoutContent>
    </NLayout>
  </NLayout>
</template>

<style scoped>
.logo {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-weight: 600;
  font-size: 16px;
  border-bottom: 1px solid var(--n-border-color);
}
.logo img {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
}
.header {
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 24px;
}
.content {
  padding: 24px;
  overflow: auto;
}
</style>
