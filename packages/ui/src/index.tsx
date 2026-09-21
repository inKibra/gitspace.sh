// @gitspace/ui — the Fluid Functionalism registry, re-exported unchanged.
// Nothing in this package styles inside a Fluid component; product code
// composes these parts with Tailwind utilities on the Fluid token set.

// ── System: providers, contexts, tokens ──
export { ShapeProvider, useShape, useShapeContext, shapeMap } from './fluid-vendor/lib/shape-context.js';
export type { ShapeClasses, ShapeVariant } from './fluid-vendor/lib/shape-context.js';
export { SizeProvider, useSize, useSizeContext, useSizeVariant, useTypeScale, sizeMap, typeScale } from './fluid-vendor/lib/size-context.js';
export type { SizeClasses, SizeVariant, TypeScaleRole, TypeScaleStep } from './fluid-vendor/lib/size-context.js';
export { IconProvider, useIcon, useIcons, defaultIcons } from './fluid-vendor/lib/icon-context.js';
export type { IconComponent, IconComponentProps, IconName } from './fluid-vendor/lib/icon-context.js';
export { untitledIcons } from './icons.js';
export { SurfaceProvider, useSurface } from './fluid-vendor/lib/surface-context.js';
export { Elevated } from './fluid-vendor/lib/elevated.js';
export { surfaceClasses, surfaceHoverClasses } from './fluid-vendor/lib/surface-classes.js';
export { spring, exitFallbackMs } from './fluid-vendor/lib/springs.js';
export { fontWeights } from './fluid-vendor/lib/font-weight.js';
export { cn } from './fluid-vendor/lib/utils.js';
export { SIDEBAR_MENU_GRID, SIDEBAR_MENU_POPUP } from './fluid-vendor/lib/sidebar-menu-grid.js';
export { useProximityHover } from './fluid-vendor/hooks/use-proximity-hover.js';
export { useTouchPrimary } from './fluid-vendor/hooks/use-touch-primary.js';

// ── Components ──
export { Accordion, AccordionContent, AccordionGroup, AccordionItem, AccordionTrigger } from './fluid-vendor/components/ui/accordion.js';
export { AskUserQuestions } from './fluid-vendor/components/ui/ask-user-questions.js';
export type { AskUserAnswer, AskUserOption, AskUserQuestion, AskUserQuestionsProps } from './fluid-vendor/components/ui/ask-user-questions.js';
export { Badge, badgeColors, badgeVariants } from './fluid-vendor/components/ui/badge.js';
export type { BadgeProps } from './fluid-vendor/components/ui/badge.js';
export { Button, buttonVariants } from './fluid-vendor/components/ui/button.js';
export type { ButtonProps } from './fluid-vendor/components/ui/button.js';
export { Card, CardAction, CardButton, CardContent, CardDescription, CardEyebrow, CardFeature, CardFooter, CardGroup, CardHeader, CardImage, CardMedia, CardTitle } from './fluid-vendor/components/ui/card.js';
export type { CardProps } from './fluid-vendor/components/ui/card.js';
export { ChatMessage } from './fluid-vendor/components/ui/chat-message.js';
export type { ChatMessageProps } from './fluid-vendor/components/ui/chat-message.js';
export { CheckboxGroup, CheckboxItem } from './fluid-vendor/components/ui/checkbox-group.js';
export { ColorPicker, ColorPickerPopover, ColorPickerPortalContainer, ColorSwatch, ColorTile } from './fluid-vendor/components/ui/color-picker.js';
export { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './fluid-vendor/components/ui/dialog.js';
export { Dropdown, DropdownContent, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger, useDropdown, useDropdownMaybe } from './fluid-vendor/components/ui/dropdown.js';
export type { DropdownContentProps, DropdownMenuProps, DropdownProps, DropdownTriggerProps } from './fluid-vendor/components/ui/dropdown.js';
export { FileThumbnail } from './fluid-vendor/components/ui/file-thumbnail.js';
export { InputCopy } from './fluid-vendor/components/ui/input-copy.js';
export type { InputCopyProps } from './fluid-vendor/components/ui/input-copy.js';
export { InputField, InputGroup } from './fluid-vendor/components/ui/input-group.js';
export { InputMessage } from './fluid-vendor/components/ui/input-message.js';
export type { InputMessageProps, QueuedMessage } from './fluid-vendor/components/ui/input-message.js';
export { MenuItem } from './fluid-vendor/components/ui/menu-item.js';
export { RadioGroup, RadioItem } from './fluid-vendor/components/ui/radio-group.js';
export { ScrollArea, ScrollBar } from './fluid-vendor/components/ui/scroll-area.js';
export { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger } from './fluid-vendor/components/ui/select.js';
export type { SelectContentProps, SelectItemProps, SelectProps, SelectTriggerProps } from './fluid-vendor/components/ui/select.js';
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupActions,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuActions,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from './fluid-vendor/components/ui/sidebar.js';
export type { SidebarContentProps, SidebarProps } from './fluid-vendor/components/ui/sidebar.js';
export { Slider, SliderComfortable } from './fluid-vendor/components/ui/slider.js';
export type { SliderComfortableProps, SliderProps, SliderValue, ValuePosition } from './fluid-vendor/components/ui/slider.js';
export { Switch } from './fluid-vendor/components/ui/switch.js';
export type { SwitchProps } from './fluid-vendor/components/ui/switch.js';
export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './fluid-vendor/components/ui/table.js';
export { TabItem, TabPanel, Tabs, TabsList } from './fluid-vendor/components/ui/tabs.js';
export type { TabItemProps, TabPanelProps, TabsListProps, TabsProps } from './fluid-vendor/components/ui/tabs.js';
export { TabsSubtle, TabsSubtleItem, TabsSubtlePanel } from './fluid-vendor/components/ui/tabs-subtle.js';
export { ThinkingIndicator } from './fluid-vendor/components/ui/thinking-indicator.js';
export type { ThinkingIndicatorProps } from './fluid-vendor/components/ui/thinking-indicator.js';
export { ThinkingStep, ThinkingStepDetails, ThinkingStepImage, ThinkingStepSource, ThinkingStepSources, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader } from './fluid-vendor/components/ui/thinking-steps.js';
export { Tooltip, TooltipPortalContainer, TooltipProvider } from './fluid-vendor/components/ui/tooltip.js';
export type { TooltipProps, TooltipProviderProps, TooltipSide } from './fluid-vendor/components/ui/tooltip.js';

// ── Blocks ──
export { QueuedStack, QUEUE_CARD_H, QUEUE_CARD_H_COMPACT, collapsedStackHeight, useQueueCardHeight } from './fluid-vendor/components/queued-stack.js';
export { SidebarInsetTopbar } from './fluid-vendor/components/sidebar-app/inset-topbar.js';
export { SidebarSearchField } from './fluid-vendor/components/sidebar-app/search-field.js';
export type { SidebarSearchFieldProps } from './fluid-vendor/components/sidebar-app/search-field.js';
export { SidebarUserFooter } from './fluid-vendor/components/sidebar-app/user-footer.js';
export type { SidebarUserFooterProps } from './fluid-vendor/components/sidebar-app/user-footer.js';
export { SidebarWorkspaceHeader, WorkspaceTile } from './fluid-vendor/components/sidebar-app/workspace-header.js';
export type { SidebarWorkspaceHeaderProps } from './fluid-vendor/components/sidebar-app/workspace-header.js';
