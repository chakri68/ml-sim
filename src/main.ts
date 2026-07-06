import "./style.css";
import { runLoader } from "./components/loader.ts";
import { startRouter } from "./router.ts";

const app = document.querySelector<HTMLDivElement>("#app")!;
const outlet = document.createElement("div");
outlet.id = "outlet";
app.append(outlet);

runLoader(app).then(() => startRouter(outlet));
