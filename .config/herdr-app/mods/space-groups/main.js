// The Spaces sidebar with groups, and the menu and dialogs it opens (as overlays
// of this same mod, told apart by props().role).

import { View } from "gpui-kit";
import { props } from "herdr";
import Sidebar from "./sidebar.js";
import Menu from "./menu.js";
import { MoveDialog, NameDialog } from "./dialogs.js";

const ROLES = { menu: Menu, move: MoveDialog, name: NameDialog };

export default class SpaceGroups extends View {
  init(initial, cx) {
    this.view = new (ROLES[props()?.role] ?? Sidebar)();
    this.view.init(initial, cx);
  }

  render(cx) {
    return this.view.render(cx);
  }
}
