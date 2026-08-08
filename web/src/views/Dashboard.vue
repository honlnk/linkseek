<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { NCard, NGrid, NGridItem, NStatistic, NSpace, NEmpty, NSpin, NRadioGroup, NRadioButton } from 'naive-ui';
import type { EChartsOption } from 'echarts';
import EChart from '../components/EChart.vue';
import { toolColor } from '../shared.js';
import { api, type OverviewStats, type TopKeysResp } from '../api.js';

/** 趋势时间范围选择 */
type RangeKey = 'today' | 'week' | 'd14' | 'd30';

/**
 * 把范围 key 映射成后端的 days 参数（后端按 UTC 分桶）。
 * - today：1（当天，配合 bucket=hour 按小时展示）
 * - week：本周一至今的天数（周一=1…周日=7），配合 bucket=hour 按小时展示
 * - d14 / d30：直接传天数，按日展示
 */
function rangeToDays(key: RangeKey): number {
  if (key === 'today') return 1;
  if (key === 'd14') return 14;
  if (key === 'd30') return 30;
  // week：计算本周一至今经过的天数（含今天）
  const now = new Date();
  const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay(); // 周日 0 → 7
  return Math.max(1, dayOfWeek);
}

/** 当天/本周用小时分桶（细粒度），近14/30天用日分桶 */
function rangeToBucket(key: RangeKey): 'hour' | 'day' {
  return key === 'today' || key === 'week' ? 'hour' : 'day';
}

const range = ref<RangeKey>('d14');
const days = computed(() => rangeToDays(range.value));
const bucket = computed(() => rangeToBucket(range.value));

const stats = ref<OverviewStats | null>(null);
const topKeys = ref<TopKeysResp | null>(null);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    const [overview, top] = await Promise.all([
      api<OverviewStats>(`/stats/overview?days=${days.value}&bucket=${bucket.value}`),
      api<TopKeysResp>(`/stats/top-keys?days=${days.value}&limit=10`),
    ]);
    stats.value = overview;
    topKeys.value = top;
  } finally {
    loading.value = false;
  }
}

// 切换时间范围时重新拉取
watch(range, load);
onMounted(load);

// ---- 工具分布饼图 ----
const pieOption = computed<EChartsOption>(() => {
  const raw = stats.value?.byTool ?? [];
  const total = raw.reduce((a, b) => a + b.count, 0);
  // 占比 < 8% 的扇区不显示标签（交给右侧列表），通过每项自带 label 配置控制
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

/** 右侧列表：按调用次数降序 */
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
/**
 * 收集趋势中出现的所有工具名（保持稳定顺序：按工具色表已知顺序优先）。
 */
const trendTools = computed(() => {
  const set = new Set<string>();
  for (const day of stats.value?.trend ?? []) {
    for (const tool of Object.keys(day.counts)) set.add(tool);
  }
  return [...set];
});

const trendOption = computed<EChartsOption>(() => {
  const trend = stats.value?.trend ?? [];
  const isHour = bucket.value === 'hour';

  // X 轴标签格式化：
  // - 小时桶 + 当天：HH:00（如 14:00）
  // - 小时桶 + 本周：MM/DD HH:00（如 08/05 14:00），点数多时省略年份
  // - 日桶：MM-DD（如 08-05）
  const fmtLabel = (raw: string) => {
    if (!isHour) return raw.slice(5); // 日桶：YYYY-MM-DD → MM-DD
    // 小时桶格式 YYYY-MM-DDTHH:00
    if (range.value === 'today') return raw.slice(11, 16); // HH:00
    return `${raw.slice(5, 10)} ${raw.slice(11, 16)}`; // MM-DD HH:00
  };
  const labels = trend.map((d) => fmtLabel(d.date));
  const pointCount = labels.length;

  // 稀疏策略：避免标签拥挤。
  // 目标约 8-12 个可见刻度 → interval ≈ ceil(pointCount / 10)
  const interval = Math.max(0, Math.ceil(pointCount / 10) - 1);

  return {
    tooltip: {
      trigger: 'axis',
      // 小时桶时在 tooltip 里显示完整日期时间
      formatter: (params: unknown) => {
        const arr = params as { axisValue: string; dataIndex: number; seriesName: string; value: number; marker: string }[];
        if (!arr.length) return '';
        const header = isHour && range.value === 'week'
          ? trend[arr[0]?.dataIndex ?? 0]?.date?.replace('T', ' ').slice(0, 16) ?? arr[0].axisValue
          : arr[0].axisValue;
        const lines = arr
          .filter((p) => p.value > 0)
          .map((p) => `${p.marker} ${p.seriesName}：${p.value}`);
        return `${header}<br/>${lines.join('<br/>')}`;
      },
    },
    legend: {
      top: 0,
      type: 'scroll',
      data: trendTools.value,
    },
    grid: { left: 40, right: 16, top: 36, bottom: 28, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: labels,
      axisLabel: { interval, fontSize: 11 },
    },
    yAxis: {
      type: 'value',
      minInterval: 1, // 请求数只能整数
      splitNumber: 4,
    },
    series: trendTools.value.map((tool) => ({
      name: tool,
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 5,
      // 点数多时隐藏数据点，只保留曲线轮廓
      showSymbol: pointCount <= 24,
      itemStyle: { color: toolColor(tool) },
      lineStyle: { width: 2 },
      areaStyle: { opacity: 0.08 },
      data: trend.map((d) => d.counts[tool] ?? 0),
    })),
  };
});

// ---- Key 调用次数排名横向柱状图 ----
/**
 * ECharts 横向柱状图：yAxis 为 category（从上到下）。
 * 数据需逆序传入（最小的在数组最前），这样排名第一显示在最上方。
 * xAxis.max 设为最大值，让第一名占满全宽，其余按比例。
 */
const topKeysOption = computed<EChartsOption>(() => {
  const items = topKeys.value?.items ?? [];
  const maxCount = items.length > 0 ? items[0].count : 1;

  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
    },
    grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
    xAxis: {
      type: 'value',
      max: Math.max(maxCount, 1), // 第一名占满全宽；全 0 时避免 0 导致除错
      axisLabel: { show: false },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'category',
      // 逆序：ECharts 默认从下往上画，逆序后第一名在最上
      data: [...items].reverse().map((i) => i.name),
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 22,
        itemStyle: { borderRadius: [0, 4, 4, 0], color: '#2080f0' },
        label: {
          show: true,
          position: 'right',
          formatter: (p: unknown) => String((p as { value?: number }).value ?? 0),
          fontSize: 12,
        },
        data: [...items].reverse().map((i) => i.count),
      },
    ],
  };
});
</script>

<template>
  <NSpin :show="loading">
    <NSpace vertical :size="16" v-if="stats">
      <!-- 数据卡片（保持不动） -->
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

      <!-- 时间范围选择器 -->
      <NRadioGroup v-model:value="range" size="small">
        <NRadioButton value="today">当天</NRadioButton>
        <NRadioButton value="week">本周</NRadioButton>
        <NRadioButton value="d14">近 14 天</NRadioButton>
        <NRadioButton value="d30">近 30 天</NRadioButton>
      </NRadioGroup>

      <!-- 工具分布：饼图 + 右侧列表 -->
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

      <!-- 请求趋势：平滑折线图 -->
      <NCard title="请求趋势">
        <EChart v-if="trendTools.length" :option="trendOption" height="320px" />
        <NEmpty v-else description="暂无趋势数据" />
      </NCard>

      <!-- Key 调用次数排名：横向柱状图 -->
      <NCard title="Key 调用次数排名">
        <EChart v-if="topKeys && topKeys.items.length" :option="topKeysOption" height="320px" />
        <NEmpty v-else description="暂无数据" />
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
  color: var(--n-text-color);
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
