<script setup lang="ts">
/**
 * ECharts 通用包装组件。
 *
 * 按需引入用到的组件（tree-shaking），遵循项目「显式 import」约定。
 * 职责：初始化实例、响应 option 变化、resize 自适应、卸载销毁。
 */
import { ref, onMounted, onUnmounted, watch, shallowRef } from 'vue';
import * as echarts from 'echarts/core';
import { PieChart, LineChart, BarChart } from 'echarts/charts';
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DatasetComponent,
} from 'echarts/components';
import { LabelLayout, UniversalTransition } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  PieChart,
  LineChart,
  BarChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DatasetComponent,
  LabelLayout,
  UniversalTransition,
  CanvasRenderer,
]);

const props = withDefaults(
  defineProps<{
    option: echarts.EChartsCoreOption;
    height?: string;
  }>(),
  { height: '320px' },
);

const el = ref<HTMLElement | null>(null);
// 用 shallowRef 避免 Vue 对 ECharts 实例做深度响应式（性能 + 避免告警）
const chart = shallowRef<echarts.ECharts | null>(null);

function resize() {
  chart.value?.resize();
}

onMounted(() => {
  if (!el.value) return;
  chart.value = echarts.init(el.value);
  chart.value.setOption(props.option);
  window.addEventListener('resize', resize);
});

watch(
  () => props.option,
  (opt) => chart.value?.setOption(opt, true),
  { deep: true },
);

onUnmounted(() => {
  window.removeEventListener('resize', resize);
  chart.value?.dispose();
  chart.value = null;
});
</script>

<template>
  <div ref="el" :style="{ width: '100%', height }"></div>
</template>
