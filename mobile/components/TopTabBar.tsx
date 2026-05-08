import FontAwesome from '@expo/vector-icons/FontAwesome';
import type { BottomTabHeaderProps } from '@react-navigation/bottom-tabs';
import { Link } from 'expo-router';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '@/components/Themed';
import { useColorScheme } from '@/components/useColorScheme';

const TABS: ReadonlyArray<{ name: 'index' | 'browser'; label: string }> = [
  { name: 'index', label: 'Chat' },
  { name: 'browser', label: 'Browser' },
];

export default function TopTabBar({ navigation, route }: BottomTabHeaderProps) {
  const insets = useSafeAreaInsets();
  const isDark = (useColorScheme() ?? 'light') === 'dark';
  const activeColor = isDark ? '#fff' : '#000';
  const inactiveColor = isDark ? '#7a7a7a' : '#9a9a9a';
  const barBg = isDark ? '#000' : '#fff';
  const borderColor = isDark ? '#1f1f1f' : '#e5e5ea';

  return (
    <RNView
      style={[
        styles.container,
        { paddingTop: insets.top, backgroundColor: barBg, borderBottomColor: borderColor },
      ]}>
      <RNView style={styles.row}>
        <RNView style={styles.tabs}>
          {TABS.map((t) => {
            const active = route.name === t.name;
            return (
              <Pressable
                key={t.name}
                style={styles.tab}
                onPress={() => navigation.navigate(t.name)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}>
                <Text
                  style={[
                    styles.tabText,
                    {
                      color: active ? activeColor : inactiveColor,
                      fontWeight: active ? '600' : '400',
                    },
                  ]}>
                  {t.label}
                </Text>
                <RNView
                  style={[
                    styles.indicator,
                    { backgroundColor: active ? activeColor : 'transparent' },
                  ]}
                />
              </Pressable>
            );
          })}
        </RNView>
        <Link href="/modal" asChild>
          <Pressable style={styles.gear} accessibilityLabel="Settings" hitSlop={10}>
            {({ pressed }) => (
              <FontAwesome
                name="cog"
                size={20}
                color={activeColor}
                style={{ opacity: pressed ? 0.4 : 0.7 }}
              />
            )}
          </Pressable>
        </Link>
      </RNView>
    </RNView>
  );
}

const styles = StyleSheet.create({
  container: { borderBottomWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'stretch', height: 44 },
  tabs: { flex: 1, flexDirection: 'row' },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  tabText: { fontSize: 15 },
  indicator: {
    position: 'absolute',
    bottom: 0,
    height: 2,
    width: '40%',
    borderRadius: 1,
  },
  gear: {
    width: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
