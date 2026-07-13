<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NCard,
  NStatistic,
  NSpace,
  NButton,
  NEmpty,
  NSpin,
  NDescriptions,
  NDescriptionsItem,
  NTag,
} from 'naive-ui';
import { api, type ApiKeyItem, type KeyStats } from '../api.js';

const route = useRoute();
const router = useRouter();

const keyDetail = ref<ApiKeyItem | null>(null);
const stats = ref<KeyStats | null>(null);
const loading = ref(true);

const maxTrendCount = computed(() => {
  if (!stats.value) return 1;
  return Math.max(
    1,
    ...stats.value.trend.map((t) => Object.values(t.counts).reduce((a, b) => a + b, 0)),
  );
});

const toolColors: Record<string, string> = {
  web_search: '#2080f0',
  web_fetch: '#18a058',
  web_search_and_fetch: '#f0a020',
};

async function load() {
  const id = route.params.id as string;
  loading.value = true;
  try {
    const [detail, st] = await Promise.all([
      api<ApiKeyItem>(`/keys/${id}`),
      api<KeyStats>(`/stats/keys/${id}?days=14`),
    ]);
    keyDetail.value = detail;
    stats.value = st;
  } catch (err) {
    keyDetail.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => route.params.id, load, { immediate: true });
</script>

<template>
  <NSpin :show="loading">
    <NSpace vertical :size="16" v-if="keyDetail && stats">
      <NSpace justify="space-between" align="center">
        <h2 style="margin: 0">{{ keyDetail.name }}</h2>
        <NButton @click="router.push({ name: 'keys' })">返回列表</NButton>
      </NSpace>

      <!-- 基本信息 -->
      <NCard>
        <NDescriptions :column="3" bordered label-placement="left">
          <NDescriptionsItem label="Key 前缀">
            <code>{{ keyDetail.tokenPrefix }}...</code>
          </NDescriptionsItem>
          <NDescriptionsItem label="状态">
            <NTag :type="keyDetail.enabled ? 'success' : 'error'">
              {{ keyDetail.enabled ? '启用' : '禁用' }}
            </NTag>
          </NDescriptionsItem>
          <NDescriptionsItem label="总请求数">
            {{ keyDetail._count?.usages ?? 0 }}
          </NDescriptionsItem>
          <NDescriptionsItem label="创建时间">
            {{ new Date(keyDetail.createdAt).toLocaleString('zh-CN') }}
          </NDescriptionsItem>
          <NDescriptionsItem label="更新时间">
            {{ new Date(keyDetail.updatedAt).toLocaleString('zh-CN') }}
          </NDescriptionsItem>
        </NDescriptions>
      </NCard>

      <!-- 按工具分布 -->
      <NCard title="按工具分布">
        <NSpace v-if="stats.byTool.length" vertical :size="8">
          <div v-for="item in stats.byTool" :key="item.tool" class="tool-bar">
            <span class="tool-name">{{ item.tool }}</span>
            <div class="bar-track">
              <div
                class="bar-fill"
                :style="{
                  width: `${(item.count / stats.total) * 100}%`,
                  background: toolColors[item.tool] ?? '#999',
                }"
              />
            </div>
            <span class="tool-count">{{ item.count }}</span>
          </div>
        </NSpace>
        <NEmpty v-else description="暂无数据" />
      </NCard>

      <!-- 近 14 天趋势 -->
      <NCard title="近 14 天请求趋势">
        <div v-if="stats.trend.length" class="trend-chart">
          <div v-for="day in stats.trend" :key="day.date" class="trend-col">
            <div class="trend-bars">
              <div
                v-for="(count, tool) in day.counts"
                :key="tool"
                class="trend-bar"
                :style="{
                  height: `${(count / maxTrendCount) * 100}%`,
                  background: toolColors[tool] ?? '#999',
                }"
                :title="`${tool}: ${count}`"
              />
            </div>
            <span class="trend-date">{{ day.date.slice(5) }}</span>
          </div>
        </div>
        <NEmpty v-else description="暂无趋势数据" />
      </NCard>
    </NSpace>
  </NSpin>
</template>

<style scoped>
.tool-bar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.tool-name {
  width: 180px;
  font-size: 13px;
}
.bar-track {
  flex: 1;
  height: 24px;
  background: #f0f0f0;
  border-radius: 4px;
  overflow: hidden;
}
.bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.3s;
}
.tool-count {
  width: 60px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.trend-chart {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 200px;
  overflow-x: auto;
  padding-bottom: 24px;
}
.trend-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 32px;
  height: 100%;
}
.trend-bars {
  flex: 1;
  display: flex;
  align-items: flex-end;
  gap: 2px;
  width: 100%;
}
.trend-bar {
  flex: 1;
  min-width: 4px;
  border-radius: 2px 2px 0 0;
  min-height: 2px;
}
.trend-date {
  font-size: 11px;
  color: #999;
  margin-top: 4px;
}
</style>
