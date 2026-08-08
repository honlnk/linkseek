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
import type { EChartsOption } from 'echarts';
import EChart from '../components/EChart.vue';
import { toolColor } from '../shared.js';
import { api, type ApiKeyItem, type KeyStats } from '../api.js';

const route = useRoute();
const router = useRouter();

const keyDetail = ref<ApiKeyItem | null>(null);
const stats = ref<KeyStats | null>(null);
const loading = ref(true);

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
  } catch {
    keyDetail.value = null;
  } finally {
    loading.value = false;
  }
}

watch(() => route.params.id, load, { immediate: true });

// ---- 工具分布饼图 ----
const pieOption = computed<EChartsOption>(() => {
  const raw = stats.value?.byTool ?? [];
  const total = raw.reduce((a, b) => a + b.count, 0);
  const data = raw.map((t) => ({
    name: t.tool,
    value: t.count,
    itemStyle: { color: toolColor(t.tool) },
    label: total > 0 && t.count / total >= 0.08 ? { show: true, formatter: '{b}', fontSize: 12 } : { show: false },
  }));

  return {
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const param = p as { name: string; value: number; percent: number };
        return `${param.name}<br/>次数：${param.value}<br/>占比：${param.percent}%`;
      },
    },
    series: [
      {
        type: 'pie',
        radius: ['42%', '70%'],
        center: ['50%', '50%'],
        avoidLabelOverlap: true,
        labelLine: { show: true, length: 8, length2: 8 },
        emphasis: {
          label: { show: true, fontWeight: 'bold', fontSize: 13 },
          itemStyle: { shadowBlur: 10, shadowColor: 'rgba(0,0,0,0.15)' },
        },
        labelLayout: { hideOverlap: true },
        data,
      },
    ],
    graphic: total === 0
      ? { type: 'text', left: 'center', top: 'middle', style: { text: '暂无数据', fontSize: 14, fill: '#999' } }
      : undefined,
  };
});

/** 右侧列表 */
const toolList = computed(() => {
  const items = stats.value?.byTool ?? [];
  const total = items.reduce((a, b) => a + b.count, 0);
  return items
    .map((t) => ({
      tool: t.tool,
      count: t.count,
      percent: total > 0 ? (t.count / total) * 100 : 0,
      color: toolColor(t.tool),
    }))
    .sort((a, b) => b.count - a.count);
});

// ---- 请求趋势平滑折线图 ----
const trendTools = computed(() => {
  const set = new Set<string>();
  for (const day of stats.value?.trend ?? []) {
    for (const tool of Object.keys(day.counts)) set.add(tool);
  }
  return [...set];
});

const trendOption = computed<EChartsOption>(() => {
  const trend = stats.value?.trend ?? [];
  const dates = trend.map((d) => d.date.slice(5));
  const pointCount = dates.length;

  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0, type: 'scroll', data: trendTools.value },
    grid: { left: 40, right: 16, top: 36, bottom: 28, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: dates,
      axisLabel: { interval: pointCount > 7 ? 1 : 0, fontSize: 11 },
    },
    yAxis: { type: 'value', minInterval: 1, splitNumber: 4 },
    series: trendTools.value.map((tool) => ({
      name: tool,
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 5,
      showSymbol: pointCount <= 14,
      itemStyle: { color: toolColor(tool) },
      lineStyle: { width: 2 },
      areaStyle: { opacity: 0.08 },
      data: trend.map((d) => d.counts[tool] ?? 0),
    })),
  };
});
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

      <!-- 按工具分布：饼图 + 右侧列表 -->
      <NCard title="按工具分布">
        <div v-if="toolList.length" class="pie-row">
          <div class="pie-wrap">
            <EChart :option="pieOption" height="280px" />
          </div>
          <div class="legend-list">
            <div v-for="item in toolList" :key="item.tool" class="legend-item">
              <span class="legend-dot" :style="{ background: item.color }"></span>
              <span class="legend-name">{{ item.tool }}</span>
              <span class="legend-count">{{ item.count }}</span>
              <span class="legend-pct">{{ item.percent.toFixed(1) }}%</span>
            </div>
          </div>
        </div>
        <NEmpty v-else description="暂无数据" />
      </NCard>

      <!-- 近 14 天趋势：平滑折线图 -->
      <NCard title="近 14 天请求趋势">
        <EChart v-if="trendTools.length" :option="trendOption" height="320px" />
        <NEmpty v-else description="暂无趋势数据" />
      </NCard>
    </NSpace>
  </NSpin>
</template>

<style scoped>
.pie-row {
  display: flex;
  gap: 24px;
  align-items: center;
}
.pie-wrap {
  flex: 0 0 50%;
  max-width: 50%;
}
.legend-list {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: 0 0 10px;
}
.legend-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.legend-count {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
.legend-pct {
  width: 56px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: #999;
}
@media (max-width: 720px) {
  .pie-row {
    flex-direction: column;
  }
  .pie-wrap {
    flex: none;
    max-width: 100%;
    width: 100%;
  }
}
</style>
