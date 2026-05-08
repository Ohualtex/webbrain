import { Tabs } from 'expo-router';
import React from 'react';

import TopTabBar from '@/components/TopTabBar';
import { useClientOnlyValue } from '@/components/useClientOnlyValue';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: useClientOnlyValue(false, true),
        header: (props) => <TopTabBar {...props} />,
        tabBarStyle: { display: 'none' },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Chat' }} />
      <Tabs.Screen name="browser" options={{ title: 'Browser' }} />
    </Tabs>
  );
}
