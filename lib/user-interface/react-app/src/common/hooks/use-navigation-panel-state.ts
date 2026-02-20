import { useState } from "react";
import { StorageHelper } from "../helpers/storage-helper";
import { NavigationPanelState } from "../types";

/**
 *  Custom hook that handles changes on navigation panel.
 *
 * @returns Array of two elements: the current state of the navigation panel, and function to execute when clicking on the panel
 */
export function useNavigationPanelState(): [
  NavigationPanelState,
  (state: Partial<NavigationPanelState>) => void
] {
  const [currentState, setCurrentState] = useState(
    StorageHelper.getNavigationPanelState()
  );

  const onChange = (state: Partial<NavigationPanelState>) => {
    console.log(state);
    setCurrentState(StorageHelper.setNavigationPanelState(state));
  };

  return [currentState, onChange];
}
