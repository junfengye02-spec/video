import {
  StoryboardWorkbench,
  type StoryboardWorkbenchProps,
} from "../features/storyboard";

export type StoryboardPageProps = StoryboardWorkbenchProps;

export function StoryboardPage(props: StoryboardPageProps) {
  return <StoryboardWorkbench {...props} />;
}
