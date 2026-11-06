/** Labrastro wordmark; mobile owns its native SVG renderer. */
import Svg, { Text } from "react-native-svg";
import { THEME } from "@/lib/theme";
import { useColorScheme } from "@/lib/use-color-scheme";

interface MulticaLogoProps {
  size?: number;
  color?: string;
}

export function MulticaLogo({ size = 24, color }: MulticaLogoProps) {
  const { isDarkColorScheme } = useColorScheme();
  const resolvedColor = color ?? (isDarkColorScheme ? THEME.dark.foreground : THEME.light.foreground);
  return (
    <Svg width={(size * 142) / 28} height={size} viewBox="0 0 142 28" accessibilityLabel="Labrastro">
      <Text x={0} y={22} fontSize={26} fontWeight="600" fill={resolvedColor}>
        Labrastro
      </Text>
    </Svg>
  );
}
