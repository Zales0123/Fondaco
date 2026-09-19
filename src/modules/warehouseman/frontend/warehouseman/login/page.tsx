import { PanelLoginForm } from '../../../components/PanelLoginForm'
import { resolveDemoWarehouseman } from '../../../lib/demoCredentials'

export default function WarehousemanLoginPage() {
  // Resolved on the server: the flag and NODE_ENV never reach the browser, and a
  // deployment that must not advertise an account simply renders no box.
  return <PanelLoginForm demoCredentials={resolveDemoWarehouseman()} />
}
