<script setup lang="ts">
import { RouterView } from 'vue-router';
import { NMessageProvider, NDialogProvider, NConfigProvider, zhCN, dateZhCN } from 'naive-ui';
</script>

<template>
  <NConfigProvider :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider>
      <NDialogProvider>
        <RouterView />
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>
