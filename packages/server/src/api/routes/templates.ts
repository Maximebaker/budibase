import * as controller from "../controllers/templates"
import { builderRoutes } from "./endpointGroups"

builderRoutes
  .get("/api/templates", controller.fetchAll)
  .get("/api/templates/:type/:name", controller.downloadTemplate)
