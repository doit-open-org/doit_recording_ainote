import { AppRegistry } from "react-native";
import App from "./App";

const componentNames = ["2026091513500001", "AiNotePanel"];

componentNames.forEach((componentName) => {
  AppRegistry.registerComponent(componentName, () => App);
});
