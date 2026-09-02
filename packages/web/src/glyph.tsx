import type { IconComponent, IconComponentProps } from '@gitspace/ui';
import type { ComponentType } from 'react';

// Untitled UI glyphs are plain 24px SVG components; Fluid's icon slots expect
// the registry's IconComponent shape ({ size, strokeWidth, className }).
type Glyph = ComponentType<{ width?: number; height?: number; strokeWidth?: number; className?: string }>;

export function glyph(Icon: Glyph): IconComponent {
  return function ProductIcon({ size, strokeWidth, className }: IconComponentProps) {
    return <Icon width={size} height={size} strokeWidth={strokeWidth} className={className} />;
  };
}
