// Biblioteca única de ícones (Lucide) — nunca emojis na interface.
// Cada import é o SVG cru do pacote lucide-static (via ?raw do Vite).
import iconCamera from "lucide-static/icons/camera.svg?raw";
import iconType from "lucide-static/icons/type.svg?raw";
import iconPackage from "lucide-static/icons/package.svg?raw";
import iconHistory from "lucide-static/icons/history.svg?raw";
import iconUser from "lucide-static/icons/user.svg?raw";
import iconHouse from "lucide-static/icons/house.svg?raw";
import iconPlus from "lucide-static/icons/plus.svg?raw";
import iconMinus from "lucide-static/icons/minus.svg?raw";
import iconTrash from "lucide-static/icons/trash-2.svg?raw";
import iconUpload from "lucide-static/icons/upload.svg?raw";
import iconSearch from "lucide-static/icons/search.svg?raw";
import iconCheckCircle from "lucide-static/icons/check-circle-2.svg?raw";
import iconAlertTriangle from "lucide-static/icons/alert-triangle.svg?raw";
import iconXCircle from "lucide-static/icons/x-circle.svg?raw";
import iconInfo from "lucide-static/icons/info.svg?raw";
import iconWifiOff from "lucide-static/icons/wifi-off.svg?raw";
import iconLoader from "lucide-static/icons/loader-circle.svg?raw";
import iconChevronLeft from "lucide-static/icons/chevron-left.svg?raw";
import iconChevronRight from "lucide-static/icons/chevron-right.svg?raw";
import iconX from "lucide-static/icons/x.svg?raw";
import iconPencil from "lucide-static/icons/pencil.svg?raw";
import iconSearchX from "lucide-static/icons/search-x.svg?raw";
import iconFileSpreadsheet from "lucide-static/icons/file-spreadsheet.svg?raw";
import iconImagePlus from "lucide-static/icons/image-plus.svg?raw";
import iconLogOut from "lucide-static/icons/log-out.svg?raw";
import iconStar from "lucide-static/icons/star.svg?raw";
import iconEye from "lucide-static/icons/eye.svg?raw";
import iconEyeOff from "lucide-static/icons/eye-off.svg?raw";
import iconRefreshCw from "lucide-static/icons/refresh-cw.svg?raw";
import iconPlay from "lucide-static/icons/play.svg?raw";
import iconFileUp from "lucide-static/icons/file-up.svg?raw";
import iconArchive from "lucide-static/icons/archive.svg?raw";
import iconImageOff from "lucide-static/icons/image-off.svg?raw";
import iconClock from "lucide-static/icons/clock.svg?raw";
import iconScan from "lucide-static/icons/scan.svg?raw";
import iconLayers from "lucide-static/icons/layers.svg?raw";
import iconTarget from "lucide-static/icons/target.svg?raw";
import iconFlashlight from "lucide-static/icons/flashlight.svg?raw";
import iconFlashlightOff from "lucide-static/icons/flashlight-off.svg?raw";
import iconSwitchCamera from "lucide-static/icons/switch-camera.svg?raw";
import iconCameraOff from "lucide-static/icons/camera-off.svg?raw";
import iconGauge from "lucide-static/icons/gauge.svg?raw";
import iconShare from "lucide-static/icons/share.svg?raw";
import iconMoreVertical from "lucide-static/icons/more-vertical.svg?raw";
import iconSquarePlus from "lucide-static/icons/square-plus.svg?raw";
import iconSmartphone from "lucide-static/icons/smartphone.svg?raw";
import iconDownload from "lucide-static/icons/download.svg?raw";
import iconCopy from "lucide-static/icons/copy.svg?raw";

export const Icon = {
  camera: iconCamera,
  type: iconType,
  package: iconPackage,
  history: iconHistory,
  user: iconUser,
  home: iconHouse,
  plus: iconPlus,
  minus: iconMinus,
  trash: iconTrash,
  upload: iconUpload,
  search: iconSearch,
  checkCircle: iconCheckCircle,
  alertTriangle: iconAlertTriangle,
  xCircle: iconXCircle,
  info: iconInfo,
  wifiOff: iconWifiOff,
  loader: iconLoader,
  chevronLeft: iconChevronLeft,
  chevronRight: iconChevronRight,
  close: iconX,
  pencil: iconPencil,
  searchX: iconSearchX,
  fileSpreadsheet: iconFileSpreadsheet,
  imagePlus: iconImagePlus,
  logOut: iconLogOut,
  star: iconStar,
  eye: iconEye,
  eyeOff: iconEyeOff,
  refresh: iconRefreshCw,
  play: iconPlay,
  fileUp: iconFileUp,
  archive: iconArchive,
  imageOff: iconImageOff,
  clock: iconClock,
  scan: iconScan,
  layers: iconLayers,
  target: iconTarget,
  flashlight: iconFlashlight,
  flashlightOff: iconFlashlightOff,
  switchCamera: iconSwitchCamera,
  cameraOff: iconCameraOff,
  gauge: iconGauge,
  share: iconShare,
  moreVertical: iconMoreVertical,
  squarePlus: iconSquarePlus,
  smartphone: iconSmartphone,
  download: iconDownload,
  copy: iconCopy,
} as const;

export type IconName = keyof typeof Icon;
