<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { NCard, NGrid, NGridItem, NStatistic, NSpace, NEmpty, NSpin } from 'naive-ui';
import { api, type OverviewStats } from '../api.js';

const stats = ref<OverviewStats | null>(null);
const loading = ref(true);

const maxTrendCount = computed(() => {
  if (!stats.value) return 1;
  return Math.max(
    1,
    ...stats.value.trend.map((t) =>
      Object.values(t.counts).reduce((a, b) => a + b, 0),
    ),
  );
});

const toolColors: Record<string, string> = {
  web_search: '#2080f0',
  web_fetch: '#18a058',
  web_search_and_fetch: '#f0a020',
};

async function load() {
  loading.value = true;
  try {
    stats.value = await api<OverviewStats>('/stats/overview?days=14');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <NSpin :show="loading">
    <NSpace vertical :size="16" v-if="stats">
      <!-- 数据卡片 -->
      <NGrid :cols="4" :x-gap="16" responsive="screen" item-responsive>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic label="总请求数" :value="stats.total" />
          </NCard>
        </NGridItem>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic label="活跃 Key" :value="stats.activeKeys" />
          </NCard>
        </NGridItem>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic label="Key 总数" :value="stats.totalKeys" />
          </NCard>
        </NGridItem>
        <NGridItem span="4 m:2 l:1">
          <NCard>
            <NStatistic
              label="日均请求"
              :value="stats.trend.length ? Math.round(stats.total / Math.max(stats.trend.length, 1)) : 0"
            />
          </NCard>
        </NGridItem>
      </NGrid>

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
