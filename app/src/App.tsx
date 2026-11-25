// Shared styles load first so each screen's own stylesheet can refine them.
import './styles/fonts.css';
import './styles/base.css';
import './styles/theme.css';
import './styles/app.css';
import { AppProvider, useApp } from './app/state';
import { useScreen, type ScreenId } from './app/router';
import { Shell } from './ui/Shell';
import { useDemoHook } from './app/demoHook';
import { AddressScreen } from './screens/AddressScreen';
import { LoadingScreen } from './screens/LoadingScreen';
import { HouseholdScreen } from './screens/HouseholdScreen';
import { HomeMapScreen } from './screens/HomeMapScreen';
import { DrillSetupScreen } from './screens/DrillSetupScreen';
import { DrillRunningScreen } from './screens/DrillRunningScreen';
import { ResultsScreen } from './screens/ResultsScreen';
import { FixScreen } from './screens/FixScreen';
import { PlanScreen } from './screens/PlanScreen';
import { HowMadeScreen } from './screens/HowMadeScreen';

const DRILL: ScreenId[] = ['setup', 'running', 'results', 'fix'];

function Screens() {
  const screen = useScreen();
  const { state } = useApp();
  useDemoHook();
  const ready = state.load.status === 'ready';
  // Screens after the address need an area; send the visitor back if there is none.
  const needsArea = !['address', 'loading', 'how'].includes(screen);
  const shown: ScreenId = needsArea && !ready ? 'address' : screen;
  const body = {
    address: <AddressScreen />,
    loading: <LoadingScreen />,
    household: <HouseholdScreen />,
    map: <HomeMapScreen />,
    setup: <DrillSetupScreen />,
    running: <DrillRunningScreen />,
    results: <ResultsScreen />,
    fix: <FixScreen />,
    plan: <PlanScreen />,
    how: <HowMadeScreen />,
  }[shown];
  return (
    <Shell screen={shown} drill={DRILL.includes(shown)} ready={ready}>
      {body}
    </Shell>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Screens />
    </AppProvider>
  );
}
