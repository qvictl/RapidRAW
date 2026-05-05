import { type PointerEvent as ReactPointerEvent, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { onBackButtonPress } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-dialog';
import { exit } from '@tauri-apps/plugin-process';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow } from '@tauri-apps/api/window';
import debounce from 'lodash.debounce';
import { ImageLRUCache, ImageCacheEntry } from './utils/ImageLRUCache';
import { ClerkProvider } from '@clerk/react';
import { ToastContainer, toast, Slide } from 'react-toastify';
import clsx from 'clsx';
import {
  Aperture,
  Check,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Edit,
  FileEdit,
  FileInput,
  Folder,
  FolderInput,
  FolderPlus,
  Images,
  LayoutTemplate,
  Redo,
  RefreshCw,
  RotateCcw,
  Star,
  SquaresUnite,
  Palette,
  Tag,
  Trash2,
  Undo,
  X,
  Pin,
  PinOff,
  Users,
  Gauge,
  Grip,
  Film,
} from 'lucide-react';
import TitleBar from './window/TitleBar';
import CommunityPage from './components/panel/CommunityPage';
import MainLibrary from './components/panel/MainLibrary';
import FolderTree from './components/panel/FolderTree';
import Editor from './components/panel/Editor';
import Controls from './components/panel/right/ControlsPanel';
import { useThumbnails } from './hooks/useThumbnails';
import { ImageDimensions } from './hooks/useImageRenderSize';
import RightPanelSwitcher from './components/panel/right/RightPanelSwitcher';
import MetadataPanel from './components/panel/right/MetadataPanel';
import CropPanel from './components/panel/right/CropPanel';
import PresetsPanel from './components/panel/right/PresetsPanel';
import AIPanel from './components/panel/right/AIPanel';
import ExportPanel from './components/panel/right/ExportPanel';
import LibraryExportPanel from './components/panel/right/LibraryExportPanel';
import MasksPanel from './components/panel/right/MasksPanel';
import BottomBar from './components/panel/BottomBar';
import { ContextMenuProvider, useContextMenu } from './context/ContextMenuContext';
import TaggingSubMenu from './context/TaggingSubMenu';
import Resizer from './components/ui/Resizer';
import {
  Adjustments,
  Color,
  COLOR_LABELS,
  COPYABLE_ADJUSTMENT_KEYS,
  INITIAL_ADJUSTMENTS,
  normalizeLoadedAdjustments,
  PasteMode,
} from './utils/adjustments';
import { calculateCenteredCrop } from './utils/cropUtils';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import GlobalTooltip from './components/ui/GlobalTooltip';
import { THEMES, DEFAULT_THEME_ID, ThemeProps } from './utils/themes';
import { Status } from './components/ui/ExportImportProperties';
import {
  AppSettings,
  FilterCriteria,
  Invokes,
  ImageFile,
  Option,
  OPTION_SEPARATOR,
  LibraryViewMode,
  Panel,
  RawStatus,
  SortDirection,
  Theme,
  Orientation,
  ThumbnailSize,
  ThumbnailAspectRatio,
} from './components/ui/AppProperties';
import { useSettingsStore } from './store/useSettingsStore';
import { useUIStore } from './store/useUIStore';
import { useLibraryStore } from './store/useLibraryStore';
import { useEditorStore } from './store/useEditorStore';
import { useProcessStore } from './store/useProcessStore';
import { useTauriListeners } from './hooks/useTauriListeners';
import { useShallow } from 'zustand/react/shallow';
import { useAiMasking } from './hooks/useAiMasking';
import { useImageProcessing } from './hooks/useImageProcessing';
import AppModals from './components/modals/AppModals';
import { useFileOperations } from './hooks/useFileOperations';

const CLERK_PUBLISHABLE_KEY = 'pk_test_YnJpZWYtc2Vhc25haWwtMTIuY2xlcmsuYWNjb3VudHMuZGV2JA'; // local dev key

interface Metadata {
  adjustments: Adjustments;
  rating: number;
  tags: Array<string> | null;
  version: number;
}

interface MultiSelectOptions {
  onSimpleClick(p: any): void;
  updateLibraryActivePath: boolean;
  shiftAnchor: string | null;
}

interface LutData {
  size: number;
}

interface ImportSettings {
  filenameTemplate: string;
  organizeByDate: boolean;
  dateFolderFormat: string;
  deleteAfterImport: boolean;
}

const RIGHT_PANEL_ORDER = [
  Panel.Metadata,
  Panel.Adjustments,
  Panel.Crop,
  Panel.Masks,
  Panel.Ai,
  Panel.Presets,
  Panel.Export,
];

const DEBUG = false;

const getParentDir = (filePath: string): string => {
  const separator = filePath.includes('/') ? '/' : '\\';
  const lastSeparatorIndex = filePath.lastIndexOf(separator);
  if (lastSeparatorIndex === -1) {
    return '';
  }
  return filePath.substring(0, lastSeparatorIndex);
};

const insertChildrenIntoTree = (node: any, targetPath: string, newChildren: any[]): any => {
  if (!node) return null;

  if (node.path === targetPath) {
    const mergedChildren = newChildren.map((newChild: any) => {
      const existingChild = node.children?.find((c: any) => c.path === newChild.path);
      if (existingChild && existingChild.children && existingChild.children.length > 0) {
        return { ...newChild, children: existingChild.children };
      }
      return newChild;
    });

    return { ...node, children: mergedChildren };
  }

  if (node.children && node.children.length > 0) {
    return {
      ...node,
      children: node.children.map((child: any) => insertChildrenIntoTree(child, targetPath, newChildren)),
    };
  }

  return node;
};

function App() {
  const COMPACT_EDITOR_MAX_WIDTH = 900;
  const DEFAULT_IMPORT_SETTINGS: ImportSettings = {
    filenameTemplate: '{original_filename}',
    organizeByDate: false,
    dateFolderFormat: 'YYYY/MM-DD',
    deleteAfterImport: false,
  };

  const {
    appSettings,
    theme,
    supportedTypes,
    osPlatform,
    setAppSettings,
    setTheme,
    setSupportedTypes,
    initPlatform,
    handleSettingsChange,
  } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      theme: state.theme,
      supportedTypes: state.supportedTypes,
      osPlatform: state.osPlatform,
      setAppSettings: state.setAppSettings,
      setTheme: state.setTheme,
      setSupportedTypes: state.setSupportedTypes,
      initPlatform: state.initPlatform,
      handleSettingsChange: state.handleSettingsChange,
    })),
  );

  const {
    activeView,
    isFullScreen,
    isWindowFullScreen,
    isInstantTransition,
    isLayoutReady,
    uiVisibility,
    isLibraryExportPanelVisible,
    leftPanelWidth,
    rightPanelWidth,
    bottomPanelHeight,
    compactEditorPanelHeightOverride,
    activeRightPanel,
    renderedRightPanel,
    slideDirection,
    renameTargetPaths,
    importTargetFolder,
    importSourcePaths,
    folderActionTarget,
    panoramaModalState,
    hdrModalState,
    negativeModalState,
    denoiseModalState,
    cullingModalState,
    collageModalState,
    setUI,
    setRightPanel,
  } = useUIStore(
    useShallow((state) => ({
      activeView: state.activeView,
      isFullScreen: state.isFullScreen,
      isWindowFullScreen: state.isWindowFullScreen,
      isInstantTransition: state.isInstantTransition,
      isLayoutReady: state.isLayoutReady,
      uiVisibility: state.uiVisibility,
      isLibraryExportPanelVisible: state.isLibraryExportPanelVisible,
      leftPanelWidth: state.leftPanelWidth,
      rightPanelWidth: state.rightPanelWidth,
      bottomPanelHeight: state.bottomPanelHeight,
      compactEditorPanelHeightOverride: state.compactEditorPanelHeightOverride,
      activeRightPanel: state.activeRightPanel,
      renderedRightPanel: state.renderedRightPanel,
      slideDirection: state.slideDirection,
      renameTargetPaths: state.renameTargetPaths,
      importTargetFolder: state.importTargetFolder,
      importSourcePaths: state.importSourcePaths,
      folderActionTarget: state.folderActionTarget,
      panoramaModalState: state.panoramaModalState,
      hdrModalState: state.hdrModalState,
      negativeModalState: state.negativeModalState,
      denoiseModalState: state.denoiseModalState,
      cullingModalState: state.cullingModalState,
      collageModalState: state.collageModalState,
      setUI: state.setUI,
      setRightPanel: state.setRightPanel,
    })),
  );

  const {
    rootPath,
    currentFolderPath,
    expandedFolders,
    folderTree,
    pinnedFolderTrees,
    imageList,
    imageRatings,
    multiSelectedPaths,
    selectionAnchorPath,
    libraryActivePath,
    libraryActiveAdjustments,
    sortCriteria,
    filterCriteria,
    searchCriteria,
    isTreeLoading,
    isViewLoading,
    setLibrary,
    setFilterCriteria,
    setSearchCriteria,
    setSortCriteria,
  } = useLibraryStore(
    useShallow((state) => ({
      rootPath: state.rootPath,
      currentFolderPath: state.currentFolderPath,
      expandedFolders: state.expandedFolders,
      folderTree: state.folderTree,
      pinnedFolderTrees: state.pinnedFolderTrees,
      imageList: state.imageList,
      imageRatings: state.imageRatings,
      multiSelectedPaths: state.multiSelectedPaths,
      selectionAnchorPath: state.selectionAnchorPath,
      libraryActivePath: state.libraryActivePath,
      libraryActiveAdjustments: state.libraryActiveAdjustments,
      sortCriteria: state.sortCriteria,
      filterCriteria: state.filterCriteria,
      searchCriteria: state.searchCriteria,
      isTreeLoading: state.isTreeLoading,
      isViewLoading: state.isViewLoading,
      setLibrary: state.setLibrary,
      setFilterCriteria: state.setFilterCriteria,
      setSearchCriteria: state.setSearchCriteria,
      setSortCriteria: state.setSortCriteria,
    })),
  );

  const {
    selectedImage,
    adjustments,
    history,
    historyIndex,
    finalPreviewUrl,
    uncroppedAdjustedPreviewUrl,
    histogram,
    waveform,
    isWaveformVisible,
    activeWaveformChannel,
    waveformHeight,
    isSliderDragging,
    activeMaskContainerId,
    activeMaskId,
    activeAiPatchContainerId,
    activeAiSubMaskId,
    zoom,
    displaySize,
    previewSize,
    baseRenderSize,
    originalSize,
    overlayMode,
    overlayRotation,
    isStraightenActive,
    brushSettings,
    isGeneratingAiMask,
    isAIConnectorConnected,
    isGeneratingAi,
    hasRenderedFirstFrame,
    setEditor,
    pushHistory,
    undo,
    redo,
    resetHistory,
  } = useEditorStore(
    useShallow((state) => ({
      selectedImage: state.selectedImage,
      adjustments: state.adjustments,
      history: state.history,
      historyIndex: state.historyIndex,
      finalPreviewUrl: state.finalPreviewUrl,
      uncroppedAdjustedPreviewUrl: state.uncroppedAdjustedPreviewUrl,
      histogram: state.histogram,
      waveform: state.waveform,
      isWaveformVisible: state.isWaveformVisible,
      activeWaveformChannel: state.activeWaveformChannel,
      waveformHeight: state.waveformHeight,
      isSliderDragging: state.isSliderDragging,
      activeMaskContainerId: state.activeMaskContainerId,
      activeMaskId: state.activeMaskId,
      activeAiPatchContainerId: state.activeAiPatchContainerId,
      activeAiSubMaskId: state.activeAiSubMaskId,
      zoom: state.zoom,
      displaySize: state.displaySize,
      previewSize: state.previewSize,
      baseRenderSize: state.baseRenderSize,
      originalSize: state.originalSize,
      overlayMode: state.overlayMode,
      overlayRotation: state.overlayRotation,
      isStraightenActive: state.isStraightenActive,
      brushSettings: state.brushSettings,
      isGeneratingAiMask: state.isGeneratingAiMask,
      isAIConnectorConnected: state.isAIConnectorConnected,
      isGeneratingAi: state.isGeneratingAi,
      hasRenderedFirstFrame: state.hasRenderedFirstFrame,
      setEditor: state.setEditor,
      pushHistory: state.pushHistory,
      undo: state.undo,
      redo: state.redo,
      resetHistory: state.resetHistory,
    })),
  );

  const setLiveAdjustments = useCallback((adj: Adjustments) => setEditor({ adjustments: adj }), [setEditor]);

  const {
    exportState,
    importState,
    isIndexing,
    indexingProgress,
    thumbnails,
    thumbnailProgress,
    aiModelDownloadStatus,
    copiedFilePaths,
    isCopied,
    isPasted,
    initialFileToOpen,
    setProcess,
    setExportState,
    setImportState,
  } = useProcessStore(
    useShallow((state) => ({
      exportState: state.exportState,
      importState: state.importState,
      isIndexing: state.isIndexing,
      indexingProgress: state.indexingProgress,
      thumbnails: state.thumbnails,
      thumbnailProgress: state.thumbnailProgress,
      aiModelDownloadStatus: state.aiModelDownloadStatus,
      copiedFilePaths: state.copiedFilePaths,
      isCopied: state.isCopied,
      isPasted: state.isPasted,
      initialFileToOpen: state.initialFileToOpen,
      setProcess: state.setProcess,
      setExportState: state.setExportState,
      setImportState: state.setImportState,
    })),
  );

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const defaultThumbnailSize = osPlatform === 'android' ? ThumbnailSize.Small : ThumbnailSize.Medium;
  const defaultLibraryViewMode = osPlatform === 'android' ? LibraryViewMode.Recursive : LibraryViewMode.Flat;

  const selectedImagePathRef = useRef<string | null>(null);
  useEffect(() => {
    selectedImagePathRef.current = selectedImage?.path ?? null;
  }, [selectedImage?.path]);

  const [error, setError] = useState<string | null>(null);

  const prevAdjustmentsRef = useRef<{ path: string; adjustments: Adjustments } | null>(null);

  const [viewportSize, setViewportSize] = useState<ImageDimensions>(() => {
    if (typeof window === 'undefined') {
      return { width: 0, height: 0 };
    }

    return {
      width: Math.round(window.visualViewport?.width ?? window.innerWidth),
      height: Math.round(window.visualViewport?.height ?? window.innerHeight),
    };
  });

  const patchesSentToBackend = useRef<Set<string>>(new Set());
  const imageCacheRef = useRef(new ImageLRUCache(20));
  const isBackendReadyRef = useRef(true);
  const cachedEditStateRef = useRef<ImageCacheEntry | null>(null);

  const [libraryViewMode, setLibraryViewMode] = useState<LibraryViewMode>(defaultLibraryViewMode);
  const [activeTreeSection, setActiveTreeSection] = useState<string | null>('current');
  const [isResizing, setIsResizing] = useState(false);
  const [thumbnailSize, setThumbnailSize] = useState(defaultThumbnailSize);
  const [thumbnailAspectRatio, setThumbnailAspectRatio] = useState(ThumbnailAspectRatio.Cover);
  const [copiedAdjustments, setCopiedAdjustments] = useState<Adjustments | null>(null);

  const [customEscapeHandler, setCustomEscapeHandler] = useState(null);

  const { showContextMenu } = useContextMenu();
  const { requestThumbnails, clearThumbnailQueue, markGenerated } = useThumbnails();

  const transformWrapperRef = useRef<any>(null);
  const isInitialMount = useRef(true);
  const currentFolderPathRef = useRef<string | null>(currentFolderPath);
  const preloadedDataRef = useRef<{
    tree?: Promise<any>;
    images?: Promise<ImageFile[]>;
    rootPath?: string;
    currentPath?: string;
  }>({});
  const isAndroid = osPlatform === 'android';
  const isPortraitViewport = viewportSize.width > 0 && viewportSize.height > viewportSize.width;
  const isCompactPortrait =
    viewportSize.width > 0 && viewportSize.width <= COMPACT_EDITOR_MAX_WIDTH && isPortraitViewport;
  const compactEditorPanelMinHeight = 220;
  const compactEditorPanelMaxHeight =
    viewportSize.height > 0
      ? Math.max(compactEditorPanelMinHeight, Math.min(Math.round(viewportSize.height * 0.85), 850))
      : 520;
  const getDynamicCompactPanelHeight = () => {
    const halfScreenHeight = viewportSize.height > 0 ? Math.round(viewportSize.height * 0.5) : 340;

    if (!selectedImage || originalSize.width === 0 || originalSize.height === 0 || viewportSize.width === 0) {
      return halfScreenHeight;
    }
    let effectiveRatio = originalSize.width / originalSize.height;
    const orientationSteps = adjustments?.orientationSteps || 0;
    if (orientationSteps % 2 !== 0) {
      effectiveRatio = originalSize.height / originalSize.width;
    }
    if (adjustments?.aspectRatio && adjustments.aspectRatio > 0) {
      effectiveRatio = adjustments.aspectRatio;
    }
    const desiredImageHeight = viewportSize.width / effectiveRatio;
    const topUiEstimation = !appSettings?.decorations && !isWindowFullScreen ? 110 : 60;
    const totalDesiredTopHeight = desiredImageHeight + topUiEstimation;
    const calculatedBottomHeight = Math.round(viewportSize.height - totalDesiredTopHeight);
    return Math.max(halfScreenHeight, calculatedBottomHeight);
  };
  const compactEditorPanelDefaultHeight = getDynamicCompactPanelHeight();
  const compactEditorPanelHeight = Math.max(
    compactEditorPanelMinHeight,
    Math.min(compactEditorPanelHeightOverride ?? compactEditorPanelDefaultHeight, compactEditorPanelMaxHeight),
  );
  const compactEditorPanelCollapsedHeight = 96;

  useEffect(() => {
    if (currentFolderPath) {
      preloadedDataRef.current = {
        ...preloadedDataRef.current,
        currentPath: currentFolderPath,
        images: Promise.resolve(imageList),
      };
    }
  }, [currentFolderPath, imageList]);

  useEffect(() => {
    if (rootPath && folderTree) {
      preloadedDataRef.current = {
        ...preloadedDataRef.current,
        rootPath: rootPath,
        tree: Promise.resolve(folderTree),
      };
    }
  }, [rootPath, folderTree]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const updateViewportSize = () => {
      const nextViewportSize = {
        width: Math.round(window.visualViewport?.width ?? window.innerWidth),
        height: Math.round(window.visualViewport?.height ?? window.innerHeight),
      };

      setViewportSize((prev) =>
        prev.width === nextViewportSize.width && prev.height === nextViewportSize.height ? prev : nextViewportSize,
      );
    };

    updateViewportSize();

    window.addEventListener('resize', updateViewportSize);
    window.addEventListener('orientationchange', updateViewportSize);
    window.visualViewport?.addEventListener('resize', updateViewportSize);

    return () => {
      window.removeEventListener('resize', updateViewportSize);
      window.removeEventListener('orientationchange', updateViewportSize);
      window.visualViewport?.removeEventListener('resize', updateViewportSize);
    };
  }, []);

  useEffect(() => {
    currentFolderPathRef.current = currentFolderPath;
  }, [currentFolderPath]);

  useEffect(() => {
    if (!isCopied) {
      return;
    }
    const timer = setTimeout(() => setProcess({ isCopied: false }), 1000);
    return () => clearTimeout(timer);
  }, [isCopied, setProcess]);

  useEffect(() => {
    if (!isPasted) {
      return;
    }
    const timer = setTimeout(() => setProcess({ isPasted: false }), 1000);
    return () => clearTimeout(timer);
  }, [isPasted, setProcess]);

  const isLightTheme = useMemo(() => [Theme.Light, Theme.Snow, Theme.Arctic].includes(theme as Theme), [theme]);

  useEffect(() => {
    if (error) {
      toast.error(error);
      setError(null);
    }
  }, [error]);

  const debouncedSetHistory = useMemo(
    () => debounce((newAdjustments) => pushHistory(newAdjustments), 500),
    [pushHistory],
  );

  const setAdjustments = useCallback(
    (value: any) => {
      setEditor((state) => {
        const prevAdjustments = state.adjustments;
        const newAdjustments = typeof value === 'function' ? value(prevAdjustments) : value;
        debouncedSetHistory(newAdjustments);
        return { adjustments: newAdjustments };
      });
    },
    [debouncedSetHistory, setEditor],
  );

  const handleRotate = useCallback(
    (degrees: number) => {
      const increment = degrees > 0 ? 1 : 3;
      setAdjustments((prev: Adjustments) => {
        const newAspectRatio = prev.aspectRatio && prev.aspectRatio !== 0 ? 1 / prev.aspectRatio : null;
        const newOrientationSteps = ((prev.orientationSteps || 0) + increment) % 4;

        const newCrop =
          selectedImage?.width && selectedImage?.height
            ? calculateCenteredCrop(selectedImage.width, selectedImage.height, newOrientationSteps, newAspectRatio)
            : null;

        return {
          ...prev,
          aspectRatio: newAspectRatio,
          orientationSteps: newOrientationSteps,
          rotation: 0,
          crop: newCrop,
        };
      });
    },
    [setAdjustments, selectedImage],
  );

  useEffect(() => {
    if (
      (activeRightPanel !== Panel.Masks || !activeMaskContainerId) &&
      (activeRightPanel !== Panel.Ai || !activeAiPatchContainerId)
    ) {
      setEditor({ isMaskControlHovered: false });
    }
  }, [activeRightPanel, activeMaskContainerId, activeAiPatchContainerId, setEditor]);

  useEffect(() => {
    if (currentFolderPath) {
      refreshImageList();
    }
  }, [libraryViewMode]);

  useEffect(() => {
    const unlisten = listen('ai-connector-status-update', (event: any) => {
      setEditor({ isAIConnectorConnected: event.payload.connected });
    });
    invoke(Invokes.CheckAIConnectorStatus);
    const interval = setInterval(() => invoke(Invokes.CheckAIConnectorStatus), 10000);
    return () => {
      clearInterval(interval);
      unlisten.then((f) => f());
    };
  }, [setEditor]);

  const debouncedSave = useCallback(
    debounce((path, adjustmentsToSave) => {
      invoke(Invokes.SaveMetadataAndUpdateThumbnail, { path, adjustments: adjustmentsToSave }).catch((err) => {
        console.error('Auto-save failed:', err);
        setError(`Failed to save changes: ${err}`);
      });
    }, 300),
    [],
  );

  const {
    handleGenerativeReplace,
    handleQuickErase,
    handleDeleteMaskContainer,
    handleDeleteAiPatch,
    handleToggleAiPatchVisibility,
    handleGenerateAiMask,
    handleGenerateAiDepthMask,
    handleGenerateAiForegroundMask,
    handleGenerateAiSkyMask,
  } = useAiMasking(setError, setAdjustments, patchesSentToBackend);

  const { applyAdjustments, currentResRef } = useImageProcessing(
    transformWrapperRef,
    imageCacheRef,
    patchesSentToBackend,
    debouncedSave,
    prevAdjustmentsRef,
  );

  const createResizeHandler = (stateKey: string, startSize: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const pointerId = e.pointerId;
    const target = e.currentTarget;
    const startX = e.clientX;
    const startY = e.clientY;

    const previousTouchAction = document.documentElement.style.touchAction;
    const previousUserSelect = document.documentElement.style.userSelect;

    target.setPointerCapture?.(pointerId);
    document.documentElement.style.touchAction = 'none';
    document.documentElement.style.userSelect = 'none';

    const doDrag = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();

      if (stateKey === 'left') {
        setUI({ leftPanelWidth: Math.round(Math.max(200, Math.min(startSize + (moveEvent.clientX - startX), 500))) });
      } else if (stateKey === 'right') {
        setUI({ rightPanelWidth: Math.round(Math.max(280, Math.min(startSize - (moveEvent.clientX - startX), 600))) });
      } else if (stateKey === 'bottom') {
        setUI({
          bottomPanelHeight: Math.round(Math.max(100, Math.min(startSize - (moveEvent.clientY - startY), 400))),
        });
      } else if (stateKey === 'compact') {
        setUI({
          compactEditorPanelHeightOverride: Math.round(
            Math.max(
              compactEditorPanelMinHeight,
              Math.min(startSize - (moveEvent.clientY - startY), compactEditorPanelMaxHeight),
            ),
          ),
        });
      }
    };

    const stopDrag = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);

      document.documentElement.style.cursor = '';
      document.documentElement.style.touchAction = previousTouchAction;
      document.documentElement.style.userSelect = previousUserSelect;

      window.removeEventListener('pointermove', doDrag);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      setIsResizing(false);
    };
    document.documentElement.style.cursor =
      stateKey === 'bottom' || stateKey === 'compact' ? 'row-resize' : 'col-resize';

    window.addEventListener('pointermove', doDrag, { passive: false });
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  };

  useEffect(() => {
    const appWindow = getCurrentWindow();
    const checkFullscreen = async () => {
      setUI({ isWindowFullScreen: await appWindow.isFullscreen() });
    };
    checkFullscreen();

    const unlistenPromise = appWindow.onResized(checkFullscreen);

    return () => {
      unlistenPromise.then((unlisten: any) => unlisten());
    };
  }, [setUI]);

  const handleLutSelect = useCallback(
    async (path: string) => {
      try {
        const result: LutData = await invoke('load_and_parse_lut', { path });
        let name = 'LUT';
        if (isAndroid) {
          name = await invoke<string>('resolve_android_content_uri_name', {
            uriStr: path,
          });
        } else {
          name = path.split(/[\\/]/).pop() || 'LUT';
        }
        setAdjustments((prev: Partial<Adjustments>) => ({
          ...prev,
          lutPath: path,
          lutName: name,
          lutSize: result.size,
          lutIntensity: 100,
          sectionVisibility: {
            ...(prev.sectionVisibility || INITIAL_ADJUSTMENTS.sectionVisibility),
            effects: true,
          },
        }));
      } catch (err) {
        console.error('Failed to load or parse LUT:', err);
        setError(`Failed to load LUT: ${err}`);
      }
    },
    [setAdjustments, isAndroid],
  );

  const handleRightPanelSelect = useCallback(
    (panelId: Panel) => {
      setRightPanel(panelId, RIGHT_PANEL_ORDER);
      setEditor({ activeMaskId: null, activeAiSubMaskId: null, isWbPickerActive: false });
    },
    [setRightPanel, setEditor],
  );

  useEffect(() => {
    initPlatform();
  }, [initPlatform]);

  useEffect(() => {
    invoke(Invokes.LoadSettings)
      .then(async (settings: any) => {
        if (
          !settings.copyPasteSettings ||
          !settings.copyPasteSettings.includedAdjustments ||
          settings.copyPasteSettings.includedAdjustments.length === 0
        ) {
          settings.copyPasteSettings = {
            mode: 'merge',
            includedAdjustments: COPYABLE_ADJUSTMENT_KEYS,
          };
        }
        setAppSettings(settings);
        if (settings?.sortCriteria) setSortCriteria(settings.sortCriteria);
        if (settings?.filterCriteria) {
          setFilterCriteria((prev: FilterCriteria) => ({
            ...prev,
            ...settings.filterCriteria,
            rawStatus: settings.filterCriteria.rawStatus || RawStatus.All,
            colors: settings.filterCriteria.colors || [],
          }));
        }
        if (settings?.theme) {
          setTheme(settings.theme);
        }
        if (settings?.uiVisibility) {
          setUI((state) => ({ uiVisibility: { ...state.uiVisibility, ...settings.uiVisibility } }));
        }
        setLibraryViewMode(settings?.libraryViewMode ?? defaultLibraryViewMode);
        setThumbnailSize(settings?.thumbnailSize ?? defaultThumbnailSize);
        if (settings?.thumbnailAspectRatio) {
          setThumbnailAspectRatio(settings.thumbnailAspectRatio);
        }
        if (settings?.activeTreeSection) {
          setActiveTreeSection(settings.activeTreeSection);
        }
        if (typeof settings?.isWaveformVisible === 'boolean') {
          setEditor({ isWaveformVisible: settings.isWaveformVisible });
        }
        if (settings?.activeWaveformChannel) {
          setEditor({ activeWaveformChannel: settings.activeWaveformChannel });
        }
        if (settings?.waveformHeight !== undefined) {
          setEditor({ waveformHeight: settings.waveformHeight });
        }
        if (settings?.pinnedFolders && settings.pinnedFolders.length > 0) {
          try {
            const trees = await invoke(Invokes.GetPinnedFolderTrees, {
              paths: settings.pinnedFolders,
              expandedFolders: settings.lastFolderState?.expandedFolders || [],
              showImageCounts: settings.enableFolderImageCounts ?? false,
            });
            setLibrary({ pinnedFolderTrees: trees });
          } catch (err) {
            console.error('Failed to load pinned folder trees:', err);
          }
        }

        if (!isAndroid && settings.lastRootPath) {
          const root = settings.lastRootPath;
          const currentPath = settings.lastFolderState?.currentFolderPath || root;

          const command =
            settings.libraryViewMode === LibraryViewMode.Recursive
              ? Invokes.ListImagesRecursive
              : Invokes.ListImagesInDir;

          preloadedDataRef.current = {
            rootPath: root,
            currentPath: currentPath,
            tree: invoke(Invokes.GetFolderTree, {
              path: root,
              expandedFolders: settings.lastFolderState?.expandedFolders ?? [root],
              showImageCounts: settings.enableFolderImageCounts ?? false,
            }),
            images: invoke(command, { path: currentPath }),
          };
        }

        invoke('frontend_ready').catch((e) => console.error('Failed to notify backend of readiness:', e));
      })
      .catch((err) => {
        console.error('Failed to load settings:', err);
        setAppSettings({
          lastRootPath: null,
          theme: DEFAULT_THEME_ID as Theme,
          thumbnailSize: defaultThumbnailSize,
          libraryViewMode: defaultLibraryViewMode,
        });
      })
      .finally(() => {
        isInitialMount.current = false;
      });
  }, [
    isAndroid,
    setAppSettings,
    setTheme,
    setUI,
    defaultLibraryViewMode,
    defaultThumbnailSize,
    setSortCriteria,
    setFilterCriteria,
    setEditor,
    setLibrary,
  ]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (JSON.stringify(appSettings.uiVisibility) !== JSON.stringify(uiVisibility)) {
      handleSettingsChange({ ...appSettings, uiVisibility });
    }
  }, [uiVisibility, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (appSettings.thumbnailSize !== thumbnailSize) {
      handleSettingsChange({ ...appSettings, thumbnailSize });
    }
  }, [thumbnailSize, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (appSettings.thumbnailAspectRatio !== thumbnailAspectRatio) {
      handleSettingsChange({ ...appSettings, thumbnailAspectRatio });
    }
  }, [thumbnailAspectRatio, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (appSettings.libraryViewMode !== libraryViewMode) {
      handleSettingsChange({ ...appSettings, libraryViewMode });
    }
  }, [libraryViewMode, appSettings, handleSettingsChange]);

  useEffect(() => {
    invoke(Invokes.GetSupportedFileTypes)
      .then((types: any) => setSupportedTypes(types))
      .catch((err) => console.error('Failed to load supported file types:', err));
  }, [setSupportedTypes]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (JSON.stringify(appSettings.sortCriteria) !== JSON.stringify(sortCriteria)) {
      handleSettingsChange({ ...appSettings, sortCriteria });
    }
  }, [sortCriteria, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (JSON.stringify(appSettings.filterCriteria) !== JSON.stringify(filterCriteria)) {
      handleSettingsChange({ ...appSettings, filterCriteria });
    }
  }, [filterCriteria, appSettings, handleSettingsChange]);

  useEffect(() => {
    if (isInitialMount.current || !appSettings) {
      return;
    }
    if (
      appSettings.isWaveformVisible !== isWaveformVisible ||
      appSettings.activeWaveformChannel !== activeWaveformChannel ||
      appSettings.waveformHeight !== waveformHeight
    ) {
      handleSettingsChange({
        ...appSettings,
        isWaveformVisible,
        activeWaveformChannel,
        waveformHeight,
      });
    }
  }, [isWaveformVisible, activeWaveformChannel, waveformHeight, appSettings, handleSettingsChange]);

  useEffect(() => {
    const root = document.documentElement;
    const currentThemeId = theme || DEFAULT_THEME_ID;

    const baseTheme =
      THEMES.find((t: ThemeProps) => t.id === currentThemeId) ||
      THEMES.find((t: ThemeProps) => t.id === DEFAULT_THEME_ID);
    if (!baseTheme) {
      return;
    }

    let finalCssVariables: any = { ...baseTheme.cssVariables };

    Object.entries(finalCssVariables).forEach(([key, value]) => {
      root.style.setProperty(key, value as string);
    });

    const fontFamily = appSettings?.fontFamily || 'poppins';
    const fontStack =
      fontFamily === 'system'
        ? '-apple-system, BlinkMacSystemFont, system-ui, sans-serif'
        : "'Poppins', system-ui, sans-serif";
    root.style.setProperty('--font-family', fontStack);
  }, [theme, appSettings?.fontFamily]);

  const refreshAllFolderTrees = useCallback(
    async (currentExpanded?: Set<string>) => {
      const activeExpanded = currentExpanded || expandedFolders;
      const expandedArr = Array.from(activeExpanded);
      const showCounts = appSettings?.enableFolderImageCounts ?? false;

      if (rootPath) {
        try {
          const treeData = await invoke(Invokes.GetFolderTree, {
            path: rootPath,
            expandedFolders: expandedArr,
            showImageCounts: showCounts,
          });
          setLibrary({ folderTree: treeData });
        } catch (err) {
          console.error('Failed to refresh main folder tree:', err);
          setError(`Failed to refresh folder tree: ${err}.`);
        }
      }

      const currentPins = appSettings?.pinnedFolders || [];
      if (currentPins.length > 0) {
        try {
          const trees = await invoke(Invokes.GetPinnedFolderTrees, {
            paths: currentPins,
            expandedFolders: expandedArr,
            showImageCounts: showCounts,
          });
          setLibrary({ pinnedFolderTrees: trees });
        } catch (err) {
          console.error('Failed to refresh pinned folder trees:', err);
        }
      }
    },
    [rootPath, appSettings?.pinnedFolders, appSettings?.enableFolderImageCounts, expandedFolders, setLibrary],
  );

  const pinnedFolders = useMemo(() => appSettings?.pinnedFolders || [], [appSettings]);

  const handleTogglePinFolder = useCallback(
    async (path: string) => {
      if (!appSettings) return;
      const currentPins = appSettings.pinnedFolders || [];
      const isPinned = currentPins.includes(path);
      const newPins = isPinned
        ? currentPins.filter((p: string) => p !== path)
        : [...currentPins, path].sort((a, b) => a.localeCompare(b));

      if (!isPinned) {
        handleActiveTreeSectionChange('pinned');
      }

      handleSettingsChange({ ...appSettings, pinnedFolders: newPins });

      try {
        const trees = await invoke(Invokes.GetPinnedFolderTrees, {
          paths: newPins,
          expandedFolders: Array.from(expandedFolders),
          showImageCounts: appSettings.enableFolderImageCounts ?? false,
        });
        setLibrary({ pinnedFolderTrees: trees });
      } catch (err) {
        console.error('Failed to refresh pinned folders:', err);
      }
    },
    [appSettings, expandedFolders, handleSettingsChange, setLibrary],
  );

  const handleActiveTreeSectionChange = (section: string | null) => {
    setActiveTreeSection(section);
    if (appSettings) {
      handleSettingsChange({ ...appSettings, activeTreeSection: section });
    }
  };

  const handleSelectSubfolder = useCallback(
    async (path: string | null, isNewRoot = false, preloadedImages?: ImageFile[], expandParents = true) => {
      await invoke('cancel_thumbnail_generation');
      clearThumbnailQueue();
      setLibrary({ isViewLoading: true });
      setSearchCriteria({ tags: [], text: '', mode: 'OR' });
      setLibrary({ libraryScrollTop: 0 });
      setProcess({ thumbnails: {} });
      imageCacheRef.current.clear();
      try {
        setLibrary({ currentFolderPath: path });
        setUI({ activeView: 'library' });

        if (isNewRoot) {
          if (path) {
            setLibrary({ expandedFolders: new Set([path]) });
          }
        } else if (path && expandParents) {
          setLibrary((state) => {
            const newSet = new Set(state.expandedFolders);
            const allRoots = [state.rootPath, ...pinnedFolders].filter(Boolean) as string[];
            const relevantRoot = allRoots.find((r) => path.startsWith(r));

            if (relevantRoot) {
              const separator = path.includes('/') ? '/' : '\\';
              const parentSeparatorIndex = path.lastIndexOf(separator);

              if (parentSeparatorIndex > -1 && path.length > relevantRoot.length) {
                let current = path.substring(0, parentSeparatorIndex);
                while (current && current.length >= relevantRoot.length) {
                  newSet.add(current);
                  const nextParentIndex = current.lastIndexOf(separator);
                  if (nextParentIndex === -1 || current === relevantRoot) {
                    break;
                  }
                  current = current.substring(0, nextParentIndex);
                }
              }
              newSet.add(relevantRoot);
            }
            return { expandedFolders: newSet };
          });
        }

        if (isNewRoot) {
          if (path && !pinnedFolders.includes(path)) {
            handleActiveTreeSectionChange('current');
          }
          setLibrary({ isTreeLoading: true });
          handleSettingsChange({ ...appSettings, lastRootPath: path } as AppSettings);
          try {
            const treeData = await invoke(Invokes.GetFolderTree, {
              path,
              expandedFolders: [path],
              showImageCounts: appSettings?.enableFolderImageCounts ?? false,
            });
            setLibrary({ folderTree: treeData });
          } catch (err) {
            console.error('Failed to load folder tree:', err);
            setError(`Failed to load folder tree: ${err}. Some sub-folders might be inaccessible.`);
          } finally {
            setLibrary({ isTreeLoading: false });
          }
        }

        setLibrary({ imageList: [], multiSelectedPaths: [], libraryActivePath: null });
        if (selectedImage) {
          debouncedSave.flush();
          debouncedSetHistory.cancel();
          setEditor({ selectedImage: null, finalPreviewUrl: null, uncroppedAdjustedPreviewUrl: null, histogram: null });
          setLiveAdjustments(INITIAL_ADJUSTMENTS);
          resetHistory(INITIAL_ADJUSTMENTS);
        }

        const command =
          libraryViewMode === LibraryViewMode.Recursive ? Invokes.ListImagesRecursive : Invokes.ListImagesInDir;

        let files: ImageFile[];
        if (preloadedImages) {
          files = preloadedImages;
        } else {
          files = await invoke(command, { path });
        }

        const initialRatings: Record<string, number> = {};
        files.forEach((f) => {
          if (f.rating !== undefined) {
            initialRatings[f.path] = f.rating;
          }
        });
        setLibrary({ imageRatings: initialRatings });

        const exifSortKeys = ['date_taken', 'iso', 'shutter_speed', 'aperture', 'focal_length'];
        const isExifSortActive = exifSortKeys.includes(sortCriteria.key);
        const shouldReadExif = appSettings?.enableExifReading ?? false;

        if (shouldReadExif && files.length > 0) {
          const paths = files.map((f: ImageFile) => f.path);

          if (isExifSortActive) {
            const exifDataMap: Record<string, any> = await invoke(Invokes.ReadExifForPaths, { paths });
            const finalImageList = files.map((image) => ({
              ...image,
              exif: exifDataMap[image.path] || image.exif || null,
            }));
            setLibrary({ imageList: finalImageList });
          } else {
            setLibrary({ imageList: files });
            invoke(Invokes.ReadExifForPaths, { paths })
              .then((exifDataMap: any) => {
                setLibrary((state) => ({
                  imageList: state.imageList.map((image) => ({
                    ...image,
                    exif: exifDataMap[image.path] || image.exif || null,
                  })),
                }));
              })
              .catch((err) => {
                console.error('Failed to read EXIF data in background:', err);
              });
          }
        } else {
          setLibrary({ imageList: files });
        }

        invoke(Invokes.StartBackgroundIndexing, { folderPath: path }).catch((err) => {
          console.error('Failed to start background indexing:', err);
        });
      } catch (err) {
        console.error('Failed to load folder contents:', err);
        setError('Failed to load images from the selected folder.');
        setLibrary({ isTreeLoading: false });
      } finally {
        setLibrary({ isViewLoading: false });
      }
    },
    [
      appSettings,
      handleSettingsChange,
      selectedImage,
      rootPath,
      sortCriteria.key,
      pinnedFolders,
      libraryViewMode,
      debouncedSave,
      debouncedSetHistory,
      resetHistory,
      setUI,
      clearThumbnailQueue,
      setLibrary,
      setSearchCriteria,
      setEditor,
      setProcess,
    ],
  );

  const handleLibraryRefresh = useCallback(() => {
    if (currentFolderPath) handleSelectSubfolder(currentFolderPath, false);
  }, [currentFolderPath, handleSelectSubfolder]);

  const refreshImageList = useCallback(async () => {
    if (!currentFolderPath) return;
    try {
      const command =
        libraryViewMode === LibraryViewMode.Recursive ? Invokes.ListImagesRecursive : Invokes.ListImagesInDir;

      const files: ImageFile[] = await invoke(command, { path: currentFolderPath });

      setLibrary((state) => {
        const newRatings = { ...state.imageRatings };
        files.forEach((f) => {
          if (f.rating !== undefined) {
            newRatings[f.path] = f.rating;
          }
        });
        return { imageRatings: newRatings };
      });

      const exifSortKeys = ['date_taken', 'iso', 'shutter_speed', 'aperture', 'focal_length'];
      const isExifSortActive = exifSortKeys.includes(sortCriteria.key);
      const shouldReadExif = appSettings?.enableExifReading ?? false;

      let freshExifData: Record<string, any> | null = null;

      if (shouldReadExif && files.length > 0 && isExifSortActive) {
        const paths = files.map((f: ImageFile) => f.path);
        freshExifData = await invoke(Invokes.ReadExifForPaths, { paths });
      }

      setLibrary((state) => {
        const prevMap = new Map(state.imageList.map((img) => [img.path, img]));

        const newImageList = files.map((newFile) => {
          if (freshExifData && freshExifData[newFile.path]) {
            newFile.exif = freshExifData[newFile.path];
            return newFile;
          }
          const existing = prevMap.get(newFile.path);
          if (existing && existing.modified === newFile.modified) {
            return existing;
          }

          return newFile;
        });
        return { imageList: newImageList };
      });

      if (shouldReadExif && files.length > 0 && !isExifSortActive) {
        const paths = files.map((f: ImageFile) => f.path);
        invoke(Invokes.ReadExifForPaths, { paths })
          .then((exifDataMap: any) => {
            setLibrary((state) => ({
              imageList: state.imageList.map((image) => {
                if (exifDataMap[image.path] && !image.exif) {
                  return { ...image, exif: exifDataMap[image.path] };
                }
                return image;
              }),
            }));
          })
          .catch((err) => {
            console.error('Failed to read EXIF data in background:', err);
          });
      }
    } catch (err) {
      console.error('Failed to refresh image list:', err);
      setError('Failed to refresh image list.');
    }
  }, [currentFolderPath, sortCriteria.key, appSettings?.enableExifReading, libraryViewMode, setLibrary]);

  useTauriListeners({
    refreshAllFolderTrees,
    handleSelectSubfolder,
    refreshImageList,
    markGenerated,
  });

  const handleToggleFolder = useCallback(
    async (path: string) => {
      const isExpanding = !expandedFolders.has(path);
      setLibrary((state) => {
        const newSet = new Set(state.expandedFolders);
        if (isExpanding) {
          newSet.add(path);
        } else {
          newSet.delete(path);
        }
        return { expandedFolders: newSet };
      });
      if (!isExpanding) return;
      try {
        const showCounts = appSettings?.enableFolderImageCounts ?? false;
        const newChildren: any[] = await invoke(Invokes.GetFolderChildren, {
          path,
          showImageCounts: showCounts,
        });
        setLibrary((state) => ({ folderTree: insertChildrenIntoTree(state.folderTree, path, newChildren) }));
        setLibrary((state) => ({
          pinnedFolderTrees: state.pinnedFolderTrees.map((tree) => insertChildrenIntoTree(tree, path, newChildren)),
        }));
      } catch (err) {
        console.error('Failed to fetch folder children:', err);
        setError(`Failed to load folder: ${err}`);
      }
    },
    [expandedFolders, appSettings?.enableFolderImageCounts, setLibrary],
  );

  useEffect(() => {
    if (isInitialMount.current || !appSettings || !rootPath) {
      return;
    }

    const newFolderState = {
      currentFolderPath,
      expandedFolders: Array.from(expandedFolders),
    };

    if (JSON.stringify(appSettings.lastFolderState) === JSON.stringify(newFolderState)) {
      return;
    }

    handleSettingsChange({ ...appSettings, lastFolderState: newFolderState });
  }, [currentFolderPath, expandedFolders, rootPath, appSettings, handleSettingsChange]);

  useEffect(() => {
    const handleGlobalContextMenu = (event: any) => {
      if (!DEBUG) event.preventDefault();
    };
    window.addEventListener('contextmenu', handleGlobalContextMenu);
    return () => window.removeEventListener('contextmenu', handleGlobalContextMenu);
  }, []);

  const handleBackToLibrary = useCallback(() => {
    if (selectedImage?.path && cachedEditStateRef.current) {
      imageCacheRef.current.set(selectedImage.path, cachedEditStateRef.current);
    }
    if (transformWrapperRef.current) {
      transformWrapperRef.current.resetTransform(0);
    }
    setEditor({ zoom: 1 });

    debouncedSave.flush();
    debouncedSetHistory.cancel();

    const lastActivePath = selectedImage?.path ?? null;

    setEditor({
      hasRenderedFirstFrame: false,
      selectedImage: null,
      finalPreviewUrl: null,
      uncroppedAdjustedPreviewUrl: null,
      histogram: null,
      waveform: null,
      activeMaskId: null,
      activeMaskContainerId: null,
      activeAiPatchContainerId: null,
      isWbPickerActive: false,
      activeAiSubMaskId: null,
    });

    selectedImagePathRef.current = null;

    setLibrary({ libraryActivePath: lastActivePath });
    setUI({ slideDirection: 1 });

    setLiveAdjustments(INITIAL_ADJUSTMENTS);
    resetHistory(INITIAL_ADJUSTMENTS);

    isBackendReadyRef.current = true;
    setEditor((state) => {
      if (state.interactivePatch?.url) URL.revokeObjectURL(state.interactivePatch.url);
      return { interactivePatch: null };
    });
  }, [selectedImage?.path, resetHistory, debouncedSave, debouncedSetHistory, setUI, setLibrary, setEditor]);

  const handleImageSelect = useCallback(
    async (path: string) => {
      if (selectedImage?.path === path) return;

      debouncedSave.flush();
      debouncedSetHistory.cancel();

      if (selectedImage?.path && cachedEditStateRef.current) {
        imageCacheRef.current.set(selectedImage.path, cachedEditStateRef.current);
      }

      patchesSentToBackend.current.clear();

      const cached = imageCacheRef.current.get(path);
      const isFrontendCached = Boolean(cached && cached.selectedImage?.isReady);
      const isCachedInBackend = isFrontendCached
        ? await invoke<boolean>('is_image_cached', { path }).catch(() => false)
        : false;

      const hasDifferentResolution =
        cached &&
        (originalSize.width !== cached.originalSize.width || originalSize.height !== cached.originalSize.height);

      if (!isCachedInBackend || hasDifferentResolution) {
        setEditor({ hasRenderedFirstFrame: false });
      }

      selectedImagePathRef.current = path;
      setLibrary({ multiSelectedPaths: [path], libraryActivePath: null, selectionAnchorPath: path });
      setError(null);

      setEditor({
        showOriginal: false,
        activeMaskId: null,
        activeMaskContainerId: null,
        activeAiPatchContainerId: null,
        activeAiSubMaskId: null,
        isWbPickerActive: false,
        transformedOriginalUrl: null,
      });

      setUI({
        isLibraryExportPanelVisible: false,
        compactEditorPanelHeightOverride: null,
      });

      if (isFrontendCached) {
        setEditor({
          selectedImage: {
            ...cached.selectedImage,
            thumbnailUrl: useProcessStore.getState().thumbnails[path] || cached.selectedImage.thumbnailUrl,
          },
          originalSize: cached.originalSize,
          previewSize: cached.previewSize,
          histogram: cached.histogram,
          waveform: cached.waveform,
          finalPreviewUrl: cached.finalPreviewUrl,
          uncroppedAdjustedPreviewUrl: cached.uncroppedPreviewUrl,
        });

        setLiveAdjustments(cached.adjustments);
        resetHistory(cached.adjustments);
        prevAdjustmentsRef.current = { path, adjustments: cached.adjustments };

        setLibrary({ isViewLoading: false });

        isBackendReadyRef.current = false;
        currentResRef.current = Infinity;

        invoke(Invokes.LoadImage, { path })
          .then((_result: any) => {
            if (selectedImagePathRef.current !== path) return;
            isBackendReadyRef.current = true;
            currentResRef.current = 0;
            setEditor({ originalSize: { width: _result.width, height: _result.height } });
          })
          .catch((err: any) => {
            if (String(err).includes('cancelled')) return;
            console.error('Background load_image failed on cache hit:', err);
            isBackendReadyRef.current = true;
            currentResRef.current = 0;
          });

        invoke(Invokes.LoadMetadata, { path })
          .then((metadata: any) => {
            if (selectedImagePathRef.current !== path) return;
            let freshAdjustments: Adjustments;
            if (metadata.adjustments && !metadata.adjustments.is_null) {
              freshAdjustments = normalizeLoadedAdjustments(metadata.adjustments);
            } else {
              freshAdjustments = { ...INITIAL_ADJUSTMENTS };
            }
            if (!isSliderDragging && JSON.stringify(cached.adjustments) !== JSON.stringify(freshAdjustments)) {
              setLiveAdjustments(freshAdjustments);
              resetHistory(freshAdjustments);
              prevAdjustmentsRef.current = { path, adjustments: freshAdjustments };
              imageCacheRef.current.set(path, { ...cached, adjustments: freshAdjustments });
            }
          })
          .catch((err) => console.error('Failed background metadata sync on cache hit:', err));

        return;
      }

      isBackendReadyRef.current = true;

      setEditor({
        selectedImage: {
          exif: null,
          height: 0,
          isRaw: false,
          isReady: false,
          metadata: null,
          originalUrl: null,
          path,
          thumbnailUrl: useProcessStore.getState().thumbnails[path],
          width: 0,
        },
        originalSize: { width: 0, height: 0 },
        previewSize: { width: 0, height: 0 },
        histogram: null,
        waveform: null,
        uncroppedAdjustedPreviewUrl: null,
      });

      setLibrary({ isViewLoading: true });

      setEditor((state) => {
        const prev = state.finalPreviewUrl;
        if (prev?.startsWith('blob:') && !imageCacheRef.current.isProtected(prev)) {
          setTimeout(() => {
            if (!imageCacheRef.current.isProtected(prev)) {
              URL.revokeObjectURL(prev);
            }
          }, 250);
        }
        return { finalPreviewUrl: null };
      });

      setEditor((state) => {
        if (state.interactivePatch?.url) URL.revokeObjectURL(state.interactivePatch.url);
        return { interactivePatch: null };
      });
    },
    [
      selectedImage?.path,
      debouncedSave,
      debouncedSetHistory,
      resetHistory,
      isSliderDragging,
      setUI,
      setLibrary,
      setEditor,
      originalSize,
    ],
  );

  useEffect(() => {
    if (selectedImage && !selectedImage.isReady && selectedImage.path) {
      let isEffectActive = true;

      const loadMetadataEarly = async () => {
        try {
          const metadata: any = await invoke(Invokes.LoadMetadata, { path: selectedImage.path });
          if (!isEffectActive) return;

          let initialAdjusts;
          if (metadata.adjustments && !metadata.adjustments.is_null) {
            initialAdjusts = normalizeLoadedAdjustments(metadata.adjustments);
          } else {
            initialAdjusts = { ...INITIAL_ADJUSTMENTS };
          }

          setEditor({ adjustments: initialAdjusts });
          resetHistory(initialAdjusts);
        } catch (err) {
          console.error('Failed to load metadata early:', err);
        }
      };

      const loadFullImageData = async () => {
        try {
          const loadImageResult: any = await invoke(Invokes.LoadImage, { path: selectedImage.path });
          if (!isEffectActive) {
            return;
          }

          const { width, height } = loadImageResult;
          setEditor({ originalSize: { width, height } });

          if (appSettings?.editorPreviewResolution) {
            const maxSize = appSettings.editorPreviewResolution;
            const aspectRatio = width / height;

            if (width > height) {
              const pWidth = Math.min(width, maxSize);
              const pHeight = Math.round(pWidth / aspectRatio);
              setEditor({ previewSize: { width: pWidth, height: pHeight } });
            } else {
              const pHeight = Math.min(height, maxSize);
              const pWidth = Math.round(pHeight * aspectRatio);
              setEditor({ previewSize: { width: pWidth, height: pHeight } });
            }
          } else {
            setEditor({ previewSize: { width: 0, height: 0 } });
          }

          setEditor((state) => {
            if (state.selectedImage && state.selectedImage.path === selectedImage.path) {
              return {
                selectedImage: {
                  ...state.selectedImage,
                  exif: loadImageResult.exif,
                  height: loadImageResult.height,
                  isRaw: loadImageResult.is_raw,
                  isReady: true,
                  metadata: loadImageResult.metadata,
                  originalUrl: null,
                  width: loadImageResult.width,
                },
              };
            }
            return state;
          });

          setEditor((state) => {
            if (!state.adjustments.aspectRatio && !state.adjustments.crop) {
              return {
                adjustments: { ...state.adjustments, aspectRatio: loadImageResult.width / loadImageResult.height },
              };
            }
            return state;
          });
        } catch (err) {
          if (isEffectActive) {
            console.error('Failed to load image:', err);
            setError(`Failed to load image: ${err}`);
            setEditor({ selectedImage: null });
          }
        } finally {
          if (isEffectActive) {
            setLibrary({ isViewLoading: false });
          }
        }
      };

      const loadAll = async () => {
        await loadMetadataEarly();
        if (isEffectActive) {
          await loadFullImageData();
        }
      };

      loadAll();

      return () => {
        isEffectActive = false;
      };
    }
  }, [selectedImage?.path, selectedImage?.isReady, appSettings?.editorPreviewResolution]);

  const sortedImageList = useMemo(() => {
    let processedList = imageList;

    if (filterCriteria.rawStatus === RawStatus.RawOverNonRaw && supportedTypes) {
      const rawBaseNames = new Set<string>();

      for (const image of imageList) {
        const pathWithoutVC = image.path.split('?vc=')[0];
        const filename = pathWithoutVC.split(/[\\/]/).pop() || '';
        const lastDotIndex = filename.lastIndexOf('.');
        const extension = lastDotIndex !== -1 ? filename.substring(lastDotIndex + 1).toLowerCase() : '';

        if (extension && supportedTypes.raw.includes(extension)) {
          const baseName = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
          const parentDir = getParentDir(pathWithoutVC);
          const uniqueKey = `${parentDir}/${baseName}`;
          rawBaseNames.add(uniqueKey);
        }
      }

      if (rawBaseNames.size > 0) {
        processedList = imageList.filter((image) => {
          const pathWithoutVC = image.path.split('?vc=')[0];
          const filename = pathWithoutVC.split(/[\\/]/).pop() || '';
          const lastDotIndex = filename.lastIndexOf('.');
          const extension = lastDotIndex !== -1 ? filename.substring(lastDotIndex + 1).toLowerCase() : '';

          const isNonRaw = extension && supportedTypes.nonRaw.includes(extension);

          if (isNonRaw) {
            const baseName = lastDotIndex !== -1 ? filename.substring(0, lastDotIndex) : filename;
            const parentDir = getParentDir(pathWithoutVC);
            const uniqueKey = `${parentDir}/${baseName}`;

            if (rawBaseNames.has(uniqueKey)) {
              return false;
            }
          }

          return true;
        });
      }
    }

    const filteredList = processedList.filter((image) => {
      if (filterCriteria.rating > 0) {
        const rating = imageRatings[image.path] || 0;
        if (filterCriteria.rating === 5) {
          if (rating !== 5) return false;
        } else {
          if (rating < filterCriteria.rating) return false;
        }
      }

      if (
        filterCriteria.rawStatus &&
        filterCriteria.rawStatus !== RawStatus.All &&
        filterCriteria.rawStatus !== RawStatus.RawOverNonRaw &&
        supportedTypes
      ) {
        const extension = image.path.split('.').pop()?.toLowerCase() || '';
        const isRaw = supportedTypes.raw?.includes(extension);

        if (filterCriteria.rawStatus === RawStatus.RawOnly && !isRaw) {
          return false;
        }
        if (filterCriteria.rawStatus === RawStatus.NonRawOnly && isRaw) {
          return false;
        }
      }

      if (filterCriteria.colors && filterCriteria.colors.length > 0) {
        const imageColor = (image.tags || []).find((tag: string) => tag.startsWith('color:'))?.substring(6);

        const hasMatchingColor = imageColor && filterCriteria.colors.includes(imageColor);
        const matchesNone = !imageColor && filterCriteria.colors.includes('none');

        if (!hasMatchingColor && !matchesNone) {
          return false;
        }
      }

      return true;
    });

    const { tags: searchTags, text: searchText, mode: searchMode } = searchCriteria;
    const lowerCaseSearchText = searchText.trim().toLowerCase();

    const filteredBySearch =
      searchTags.length === 0 && lowerCaseSearchText === ''
        ? filteredList
        : filteredList.filter((image: ImageFile) => {
            const lowerCaseImageTags = (image.tags || []).map((t) => t.toLowerCase().replace('user:', ''));
            const filename = image?.path?.split(/[\\/]/)?.pop()?.toLowerCase() || '';

            let tagsMatch = true;
            if (searchTags.length > 0) {
              const lowerCaseSearchTags = searchTags.map((t) => t.toLowerCase());
              if (searchMode === 'OR') {
                tagsMatch = lowerCaseSearchTags.some((searchTag) =>
                  lowerCaseImageTags.some((imgTag) => imgTag.includes(searchTag)),
                );
              } else {
                tagsMatch = lowerCaseSearchTags.every((searchTag) =>
                  lowerCaseImageTags.some((imgTag) => imgTag.includes(searchTag)),
                );
              }
            }

            let textMatch = true;
            if (lowerCaseSearchText !== '') {
              textMatch =
                filename.includes(lowerCaseSearchText) ||
                lowerCaseImageTags.some((t) => t.includes(lowerCaseSearchText));
            }

            return tagsMatch && textMatch;
          });

    const list = [...filteredBySearch];

    const parseShutter = (val: string | undefined): number | null => {
      if (!val) return null;
      const cleanVal = val.replace(/s/i, '').trim();
      const parts = cleanVal.split('/');
      if (parts.length === 2) {
        const num = parseFloat(parts[0]);
        const den = parseFloat(parts[1]);
        return den !== 0 ? num / den : null;
      }
      const numVal = parseFloat(cleanVal);
      return isNaN(numVal) ? null : numVal;
    };

    const parseAperture = (val: string | undefined): number | null => {
      if (!val) return null;
      const match = val.match(/(\d+(\.\d+)?)/);
      const numVal = match ? parseFloat(match[0]) : null;
      return numVal === null || isNaN(numVal) ? null : numVal;
    };

    const parseFocalLength = (val: string | undefined): number | null => {
      if (!val) return null;
      const match = val.match(/(\d+(\.\d+)?)/);
      if (!match) return null;
      const numVal = parseFloat(match[0]);
      return isNaN(numVal) ? null : numVal;
    };

    list.sort((a, b) => {
      const { key, order } = sortCriteria;
      let comparison = 0;

      const compareNullable = (valA: any, valB: any) => {
        if (valA !== null && valB !== null) {
          if (valA < valB) return -1;
          if (valA > valB) return 1;
          return 0;
        }
        if (valA !== null) return -1;
        if (valB !== null) return 1;
        return 0;
      };

      switch (key) {
        case 'date_taken': {
          const dateA = a.exif?.DateTimeOriginal;
          const dateB = b.exif?.DateTimeOriginal;
          comparison = compareNullable(dateA, dateB);
          if (comparison === 0) comparison = a.modified - b.modified;
          break;
        }
        case 'iso': {
          const getIso = (exif: { [key: string]: string } | null): number | null => {
            if (!exif) return null;
            const isoStr = exif.PhotographicSensitivity || exif.ISOSpeedRatings;
            if (!isoStr) return null;
            const isoNum = parseInt(isoStr, 10);
            return isNaN(isoNum) ? null : isoNum;
          };
          const isoA = getIso(a.exif);
          const isoB = getIso(b.exif);
          comparison = compareNullable(isoA, isoB);
          break;
        }
        case 'shutter_speed': {
          const shutterA = parseShutter(a.exif?.ExposureTime);
          const shutterB = parseShutter(b.exif?.ExposureTime);
          comparison = compareNullable(shutterA, shutterB);
          break;
        }
        case 'aperture': {
          const apertureA = parseAperture(a.exif?.FNumber);
          const apertureB = parseAperture(b.exif?.FNumber);
          comparison = compareNullable(apertureA, apertureB);
          break;
        }
        case 'focal_length': {
          const focalA = parseFocalLength(a.exif?.FocalLength);
          const focalB = parseFocalLength(b.exif?.FocalLength);
          comparison = compareNullable(focalA, focalB);
          break;
        }
        case 'date':
          comparison = a.modified - b.modified;
          break;
        case 'rating':
          comparison = (imageRatings[a.path] || 0) - (imageRatings[b.path] || 0);
          break;
        default:
          comparison = a.path.localeCompare(b.path);
          break;
      }

      if (comparison === 0 && key !== 'name') {
        return a.path.localeCompare(b.path);
      }

      return order === SortDirection.Ascending ? comparison : -comparison;
    });
    return list;
  }, [imageList, sortCriteria, imageRatings, filterCriteria, supportedTypes, searchCriteria, appSettings]);

  const {
    executeDelete,
    handleDeleteSelected,
    handleCreateFolder,
    handleRenameFolder,
    handleSaveRename,
    handleStartImport,
    startImportFiles,
    handlePasteFiles,
  } = useFileOperations(
    setError,
    refreshImageList,
    refreshAllFolderTrees,
    handleImageSelect,
    handleBackToLibrary,
    sortedImageList,
  );

  const handleToggleFullScreen = useCallback(() => {
    const currentlyZoomed = zoom > 1.01;
    setUI({ isInstantTransition: currentlyZoomed });

    if (isFullScreen) {
      setUI({ isFullScreen: false });
    } else {
      if (!selectedImage) {
        return;
      }
      setUI({ isFullScreen: true });
    }

    if (currentlyZoomed) {
      setTimeout(() => setUI({ isInstantTransition: false }), 100);
    }
  }, [isFullScreen, selectedImage, zoom, setUI]);

  useEffect(() => {
    if (!isAndroid) {
      return;
    }

    let isDisposed = false;
    let listener: { unregister: () => Promise<void> } | null = null;
    const isEditorOpen = !!selectedImage;

    onBackButtonPress(() => {
      if (isFullScreen) {
        setUI({ isFullScreen: false });
        return;
      }

      if (isEditorOpen) {
        handleBackToLibrary();
        return;
      }

      void exit(0).catch((err) => {
        console.error('Failed to exit app from Android back gesture:', err);
      });
    })
      .then((registeredListener) => {
        if (isDisposed) {
          void registeredListener.unregister().catch((err) => {
            console.error('Failed to unregister stale Android back gesture handler:', err);
          });
          return;
        }
        listener = registeredListener;
      })
      .catch((err) => {
        console.error('Failed to register Android back gesture handler:', err);
      });

    return () => {
      isDisposed = true;
      void listener?.unregister().catch((err) => {
        console.error('Failed to unregister Android back gesture handler:', err);
      });
    };
  }, [isAndroid, isFullScreen, selectedImage?.path, handleBackToLibrary, setUI]);

  const handleCopyAdjustments = useCallback(() => {
    const sourceAdjustments = selectedImage ? adjustments : libraryActiveAdjustments;
    const adjustmentsToCopy: any = {};

    for (const key of COPYABLE_ADJUSTMENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(sourceAdjustments, key)) {
        adjustmentsToCopy[key] = structuredClone(sourceAdjustments[key]);
      }
    }

    setCopiedAdjustments(adjustmentsToCopy);
    setProcess({ isCopied: true });
  }, [selectedImage, adjustments, libraryActiveAdjustments, setProcess]);

  const handlePasteAdjustments = useCallback(
    (paths?: Array<string>) => {
      if (!copiedAdjustments || !appSettings) {
        return;
      }

      const { mode, includedAdjustments } = appSettings.copyPasteSettings;

      const adjustmentsToApply: Partial<Adjustments> = {};

      for (const key of includedAdjustments) {
        if (Object.prototype.hasOwnProperty.call(copiedAdjustments, key)) {
          const value = copiedAdjustments[key as keyof Adjustments];

          if (mode === PasteMode.Merge) {
            const defaultValue = INITIAL_ADJUSTMENTS[key as keyof Adjustments];
            if (JSON.stringify(value) !== JSON.stringify(defaultValue)) {
              adjustmentsToApply[key as keyof Adjustments] = value;
            }
          } else {
            adjustmentsToApply[key as keyof Adjustments] = value;
          }
        }
      }

      if (Object.keys(adjustmentsToApply).length === 0) {
        setProcess({ isPasted: true });
        return;
      }

      const pathsToUpdate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToUpdate.length === 0) {
        return;
      }

      pathsToUpdate.forEach((p) => imageCacheRef.current.delete(p));

      if (selectedImage && pathsToUpdate.includes(selectedImage.path)) {
        const newAdjustments = { ...adjustments, ...adjustmentsToApply };
        setAdjustments(newAdjustments);
      }

      invoke(Invokes.ApplyAdjustmentsToPaths, { paths: pathsToUpdate, adjustments: adjustmentsToApply }).catch(
        (err) => {
          console.error('Failed to paste adjustments to multiple images:', err);
          setError(`Failed to paste adjustments: ${err}`);
        },
      );
      setProcess({ isPasted: true });
    },
    [copiedAdjustments, appSettings, multiSelectedPaths, selectedImage, adjustments, setAdjustments, setProcess],
  );

  const handleAutoAdjustments = async () => {
    if (!selectedImage?.isReady) {
      return;
    }
    imageCacheRef.current.delete(selectedImage.path);
    try {
      const autoAdjustments: Adjustments = await invoke(Invokes.CalculateAutoAdjustments);
      setAdjustments((prev: Adjustments) => {
        const newAdjustments = { ...prev, ...autoAdjustments };
        newAdjustments.sectionVisibility = {
          ...prev.sectionVisibility,
          ...autoAdjustments.sectionVisibility,
        };

        return newAdjustments;
      });
    } catch (err) {
      console.error('Failed to calculate auto adjustments:', err);
      setError(`Failed to apply auto adjustments: ${err}`);
    }
  };

  const handleRate = useCallback(
    (newRating: number, paths?: Array<string>) => {
      const pathsToRate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToRate.length === 0) {
        return;
      }

      const currentRating = imageRatings[pathsToRate[0]] || 0;
      const finalRating = newRating === currentRating ? 0 : newRating;

      setLibrary((state) => {
        const newRatings = { ...state.imageRatings };
        pathsToRate.forEach((path: string) => {
          newRatings[path] = finalRating;
        });
        return { imageRatings: newRatings };
      });

      invoke(Invokes.SetRatingForPaths, { paths: pathsToRate, rating: finalRating }).catch((err) => {
        console.error('Failed to apply rating to paths:', err);
        setError(`Failed to apply rating: ${err}`);
      });
    },
    [multiSelectedPaths, selectedImage, imageRatings, setLibrary],
  );

  const handleUpdateExif = useCallback(
    async (paths: Array<string> | undefined, updates: Record<string, string>) => {
      const pathsToUpdate =
        paths && paths.length > 0
          ? paths
          : multiSelectedPaths.length > 0
            ? multiSelectedPaths
            : selectedImage
              ? [selectedImage.path]
              : [];
      if (pathsToUpdate.length === 0) return;

      const physicalPathsSet = new Set(pathsToUpdate.map((p) => p.split('?vc=')[0]));
      const physicalPathsArray = Array.from(physicalPathsSet);

      try {
        await invoke(Invokes.UpdateExifFields, {
          paths: physicalPathsArray,
          updates,
        });

        setEditor((state) => {
          if (!state.selectedImage || !physicalPathsSet.has(state.selectedImage.path.split('?vc=')[0])) return state;
          return {
            selectedImage: {
              ...state.selectedImage,
              exif: {
                ...(state.selectedImage.exif || {}),
                ...updates,
              },
            },
          };
        });

        setLibrary((state) => ({
          imageList: state.imageList.map((img) => {
            if (physicalPathsSet.has(img.path.split('?vc=')[0])) {
              return {
                ...img,
                exif: { ...(img.exif || {}), ...updates },
              };
            }
            return img;
          }),
        }));

        pathsToUpdate.forEach((p) => {
          const cached = imageCacheRef.current.get(p);
          if (cached && cached.selectedImage) {
            imageCacheRef.current.set(p, {
              ...cached,
              selectedImage: {
                ...cached.selectedImage,
                exif: { ...(cached.selectedImage.exif || {}), ...updates },
              },
            });
          }
        });
      } catch (err) {
        console.error('Failed to update EXIF data:', err);
        setError(`Failed to update metadata: ${err}`);
      }
    },
    [multiSelectedPaths, selectedImage, setLibrary, setEditor],
  );

  const handleSetColorLabel = useCallback(
    async (color: string | null, paths?: Array<string>) => {
      const pathsToUpdate =
        paths || (multiSelectedPaths.length > 0 ? multiSelectedPaths : selectedImage ? [selectedImage.path] : []);
      if (pathsToUpdate.length === 0) {
        return;
      }
      const primaryPath = selectedImage?.path || libraryActivePath;
      const primaryImage = imageList.find((img: ImageFile) => img.path === primaryPath);
      let currentColor = null;
      if (primaryImage && primaryImage.tags) {
        const colorTag = primaryImage.tags.find((tag: string) => tag.startsWith('color:'));
        if (colorTag) {
          currentColor = colorTag.substring(6);
        }
      }
      const finalColor = color !== null && color === currentColor ? null : color;
      try {
        await invoke(Invokes.SetColorLabelForPaths, { paths: pathsToUpdate, color: finalColor });

        setLibrary((state) => ({
          imageList: state.imageList.map((image: ImageFile) => {
            if (pathsToUpdate.includes(image.path)) {
              const otherTags = (image.tags || []).filter((tag: string) => !tag.startsWith('color:'));
              const newTags = finalColor ? [...otherTags, `color:${finalColor}`] : otherTags;
              return { ...image, tags: newTags };
            }
            return image;
          }),
        }));
      } catch (err) {
        console.error('Failed to set color label:', err);
        setError(`Failed to set color label: ${err}`);
      }
    },
    [multiSelectedPaths, selectedImage, libraryActivePath, imageList, setLibrary],
  );

  const getCommonTags = useCallback(
    (paths: string[]): { tag: string; isUser: boolean }[] => {
      if (paths.length === 0) return [];
      const imageFiles = imageList.filter((img) => paths.includes(img.path));
      if (imageFiles.length === 0) return [];

      const allTagsSets = imageFiles.map((img) => {
        const tagsWithPrefix = (img.tags || []).filter((t) => !t.startsWith('color:'));
        return new Set(tagsWithPrefix);
      });

      if (allTagsSets.length === 0) return [];

      const commonTagsWithPrefix = allTagsSets.reduce((intersection, currentSet) => {
        return new Set([...intersection].filter((tag) => currentSet.has(tag)));
      });

      return Array.from(commonTagsWithPrefix)
        .map((tag) => ({
          tag: tag.startsWith('user:') ? tag.substring(5) : tag,
          isUser: tag.startsWith('user:'),
        }))
        .sort((a, b) => a.tag.localeCompare(b.tag));
    },
    [imageList],
  );

  const handleTagsChanged = useCallback(
    (changedPaths: string[], newTags: { tag: string; isUser: boolean }[]) => {
      setLibrary((state) => ({
        imageList: state.imageList.map((image) => {
          if (changedPaths.includes(image.path)) {
            const colorTags = (image.tags || []).filter((t) => t.startsWith('color:'));
            const prefixedNewTags = newTags.map((t) => (t.isUser ? `user:${t.tag}` : t.tag));
            const finalTags = [...colorTags, ...prefixedNewTags].sort();
            return { ...image, tags: finalTags.length > 0 ? finalTags : null };
          }
          return image;
        }),
      }));
    },
    [setLibrary],
  );

  const handleZoomChange = useCallback(
    (zoomValue: number, fitToWindow: boolean = false) => {
      const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
      let targetZoomPercent: number;

      const orientationSteps = adjustments.orientationSteps || 0;
      const isSwapped = orientationSteps === 1 || orientationSteps === 3;
      const effectiveOriginalWidth = isSwapped ? originalSize.height : originalSize.width;
      const effectiveOriginalHeight = isSwapped ? originalSize.width : originalSize.height;

      if (fitToWindow) {
        if (
          effectiveOriginalWidth > 0 &&
          effectiveOriginalHeight > 0 &&
          baseRenderSize.width > 0 &&
          baseRenderSize.height > 0
        ) {
          const originalAspect = effectiveOriginalWidth / effectiveOriginalHeight;
          const baseAspect = baseRenderSize.width / baseRenderSize.height;
          if (originalAspect > baseAspect) {
            targetZoomPercent = baseRenderSize.width / effectiveOriginalWidth;
          } else {
            targetZoomPercent = baseRenderSize.height / effectiveOriginalHeight;
          }
        } else {
          targetZoomPercent = 1.0;
        }
      } else {
        targetZoomPercent = zoomValue / dpr;
      }

      targetZoomPercent = Math.max(0.1 / dpr, Math.min(2.0, targetZoomPercent));

      let transformZoom = 1.0;
      if (
        effectiveOriginalWidth > 0 &&
        effectiveOriginalHeight > 0 &&
        baseRenderSize.width > 0 &&
        baseRenderSize.height > 0
      ) {
        const originalAspect = effectiveOriginalWidth / effectiveOriginalHeight;
        const baseAspect = baseRenderSize.width / baseRenderSize.height;
        if (originalAspect > baseAspect) {
          transformZoom = (targetZoomPercent * effectiveOriginalWidth) / baseRenderSize.width;
        } else {
          transformZoom = (targetZoomPercent * effectiveOriginalHeight) / baseRenderSize.height;
        }
      }
      setEditor({ zoom: transformZoom });
    },
    [originalSize, baseRenderSize, adjustments.orientationSteps, setEditor],
  );

  const isAnyModalOpen = useUIStore(
    (state) =>
      state.isCreateFolderModalOpen ||
      state.isRenameFolderModalOpen ||
      state.isRenameFileModalOpen ||
      state.isImportModalOpen ||
      state.isCopyPasteSettingsModalOpen ||
      state.confirmModalState.isOpen ||
      state.panoramaModalState.isOpen ||
      state.cullingModalState.isOpen ||
      state.collageModalState.isOpen ||
      state.denoiseModalState.isOpen ||
      state.negativeModalState.isOpen,
  );

  useKeyboardShortcuts({
    isModalOpen: isAnyModalOpen,
    osPlatform,
    activeAiPatchContainerId,
    activeAiSubMaskId,
    activeMaskContainerId,
    activeMaskId,
    activeRightPanel,
    canRedo,
    canUndo,
    copiedFilePaths,
    customEscapeHandler,
    handleBackToLibrary,
    handleCopyAdjustments,
    handleDeleteAiPatch,
    handleDeleteMaskContainer,
    handleDeleteSelected,
    handleImageSelect,
    handlePasteAdjustments,
    handlePasteFiles,
    handleRate,
    handleRightPanelSelect,
    handleRotate,
    handleSetColorLabel,
    handleToggleFullScreen,
    handleZoomChange,
    isFullScreen,
    isStraightenActive,
    libraryActivePath,
    multiSelectedPaths,
    redo,
    selectedImage,
    setActiveAiSubMaskId: (id) => setEditor({ activeAiSubMaskId: id }),
    setActiveMaskContainerId: (id) => setEditor({ activeMaskContainerId: id }),
    setActiveMaskId: (id) => setEditor({ activeMaskId: id }),
    setCopiedFilePaths: (paths) => setProcess({ copiedFilePaths: paths }),
    setIsStraightenActive: (v) => setEditor({ isStraightenActive: v }),
    setIsWaveformVisible: (v) => setEditor({ isWaveformVisible: v }),
    setLibraryActivePath: (path) => setLibrary({ libraryActivePath: path }),
    setMultiSelectedPaths: (paths) => setLibrary({ multiSelectedPaths: paths }),
    setShowOriginal: (v) => setEditor({ showOriginal: v }),
    sortedImageList,
    undo,
    zoom,
    displaySize,
    baseRenderSize,
    originalSize,
    keybinds: appSettings?.keybinds,
    brushSettings: brushSettings,
    setBrushSettings: (s) => setEditor({ brushSettings: s }),
  });

  const handleStartPanorama = (paths: string[]) => {
    setUI((state) => ({
      panoramaModalState: {
        ...state.panoramaModalState,
        isProcessing: true,
        error: null,
        finalImageBase64: null,
        progressMessage: 'Starting panorama process...',
      },
    }));
    invoke(Invokes.StitchPanorama, { paths }).catch((err) => {
      setUI((state) => ({
        panoramaModalState: {
          ...state.panoramaModalState,
          isProcessing: false,
          error: String(err),
        },
      }));
    });
  };

  const handleSavePanorama = async (): Promise<string> => {
    if (panoramaModalState.stitchingSourcePaths.length === 0) {
      const err = 'Source paths for panorama not found.';
      setUI((state) => ({ panoramaModalState: { ...state.panoramaModalState, error: err } }));
      throw new Error(err);
    }

    try {
      const savedPath: string = await invoke(Invokes.SavePanorama, {
        firstPathStr: panoramaModalState.stitchingSourcePaths[0],
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save panorama:', err);
      setUI((state) => ({ panoramaModalState: { ...state.panoramaModalState, error: String(err) } }));
      throw err;
    }
  };

  const handleStartHdr = (paths: string[]) => {
    setUI((state) => ({
      hdrModalState: {
        ...state.hdrModalState,
        isProcessing: true,
        error: null,
        finalImageBase64: null,
        progressMessage: 'Starting HDR process...',
      },
    }));
    invoke(Invokes.MergeHdr, { paths }).catch((err) => {
      setUI((state) => ({
        hdrModalState: {
          ...state.hdrModalState,
          isProcessing: false,
          error: String(err),
        },
      }));
    });
  };

  const handleSaveHdr = async (): Promise<string> => {
    if (hdrModalState.stitchingSourcePaths.length === 0) {
      const err = 'Source paths for HDR not found.';
      setUI((state) => ({ hdrModalState: { ...state.hdrModalState, error: err } }));
      throw new Error(err);
    }

    try {
      const savedPath: string = await invoke(Invokes.SaveHdr, {
        firstPathStr: hdrModalState.stitchingSourcePaths[0],
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save HDR image:', err);
      setUI((state) => ({ hdrModalState: { ...state.hdrModalState, error: String(err) } }));
      throw err;
    }
  };

  const handleApplyDenoise = useCallback(
    async (intensity: number, method: 'ai' | 'bm3d') => {
      if (denoiseModalState.targetPaths.length === 0) return;

      setUI((state) => ({
        denoiseModalState: {
          ...state.denoiseModalState,
          isProcessing: true,
          error: null,
          progressMessage: 'Starting engine...',
        },
      }));

      try {
        await invoke(Invokes.ApplyDenoising, {
          path: denoiseModalState.targetPaths[0],
          intensity: intensity,
          method: method,
        });
      } catch (err) {
        setUI((state) => ({
          denoiseModalState: {
            ...state.denoiseModalState,
            isProcessing: false,
            error: String(err),
          },
        }));
      }
    },
    [denoiseModalState.targetPaths, setUI],
  );

  const handleBatchDenoise = useCallback(
    async (intensity: number, method: 'ai' | 'bm3d', paths: string[]) => {
      try {
        const savedPaths: string[] = await invoke('batch_denoise_images', {
          paths,
          intensity,
          method,
        });
        await refreshImageList();
        return savedPaths;
      } catch (err) {
        setUI((state) => ({
          denoiseModalState: {
            ...state.denoiseModalState,
            error: String(err),
          },
        }));
        throw err;
      }
    },
    [refreshImageList, setUI],
  );

  const handleSaveDenoisedImage = async (): Promise<string> => {
    if (denoiseModalState.targetPaths.length === 0) throw new Error('No target path');
    const savedPath = await invoke<string>(Invokes.SaveDenoisedImage, {
      originalPathStr: denoiseModalState.targetPaths[0],
    });
    await refreshImageList();
    return savedPath;
  };

  const handleSaveCollage = async (base64Data: string, firstPath: string): Promise<string> => {
    try {
      const savedPath: string = await invoke(Invokes.SaveCollage, {
        base64Data,
        firstPathStr: firstPath,
      });
      await refreshImageList();
      return savedPath;
    } catch (err) {
      console.error('Failed to save collage:', err);
      setError(`Failed to save collage: ${err}`);
      throw err;
    }
  };

  const handleOpenFolder = async () => {
    try {
      if (isAndroid) {
        const libraryRoot = await invoke<string>(Invokes.GetOrCreateInternalLibraryRoot);
        setLibrary({ rootPath: libraryRoot });
        await handleSelectSubfolder(libraryRoot, true);
        return;
      }

      const selected = await open({ directory: true, multiple: false, defaultPath: await homeDir() });
      if (typeof selected === 'string') {
        setLibrary({ rootPath: selected });
        await handleSelectSubfolder(selected, true);
      }
    } catch (err) {
      console.error(isAndroid ? 'Failed to open Android library root:' : 'Failed to open directory dialog:', err);
      setError(isAndroid ? 'Failed to open library.' : 'Failed to open folder selection dialog.');
    }
  };

  useEffect(() => {
    if (!rootPath) {
      setUI({ isLayoutReady: false });
      return;
    }

    const timer = setTimeout(() => {
      setUI({ isLayoutReady: true });
    }, 100);

    return () => clearTimeout(timer);
  }, [rootPath, setUI]);

  const handleContinueSession = () => {
    const restore = async () => {
      if (!appSettings?.lastRootPath) {
        return;
      }

      const root = appSettings.lastRootPath;
      const folderState = appSettings.lastFolderState;
      const pathToSelect = folderState?.currentFolderPath || root;

      setLibrary({ rootPath: root });

      if (folderState?.expandedFolders) {
        const newExpandedFolders = new Set<string>(folderState.expandedFolders);
        setLibrary({ expandedFolders: newExpandedFolders });
      } else {
        setLibrary({ expandedFolders: new Set([root]) });
      }

      setLibrary({ isTreeLoading: true });
      try {
        let treeData;
        if (preloadedDataRef.current.rootPath === root && preloadedDataRef.current.tree) {
          treeData = await preloadedDataRef.current.tree;
          console.log('Preload cache hit for folder tree.');
        } else {
          const expandedArr = folderState?.expandedFolders ? Array.from(new Set(folderState.expandedFolders)) : [root];
          treeData = await invoke(Invokes.GetFolderTree, {
            path: root,
            expandedFolders: expandedArr,
            showImageCounts: appSettings?.enableFolderImageCounts ?? false,
          });
        }
        setLibrary({ folderTree: treeData });
      } catch (err) {
        console.error('Failed to restore folder tree:', err);
      } finally {
        setLibrary({ isTreeLoading: false });
      }

      let preloadedImages: ImageFile[] | undefined = undefined;
      if (preloadedDataRef.current.currentPath === pathToSelect && preloadedDataRef.current.images) {
        try {
          preloadedImages = await preloadedDataRef.current.images;
          console.log('Preload cache hit for image list.');
        } catch (e) {
          console.error('Failed to retrieve preloaded images', e);
        }
      }

      await handleSelectSubfolder(pathToSelect, false, preloadedImages, false);
    };
    restore().catch((err) => {
      console.error('Failed to restore session, folder might be missing:', err);
      setError('Failed to restore session. The last used folder may have been moved or deleted.');
      if (appSettings) {
        handleSettingsChange({ ...appSettings, lastRootPath: null, lastFolderState: null });
      }
      handleGoHome();
      setLibrary({ isTreeLoading: false });
    });
  };

  useEffect(() => {
    if (!initialFileToOpen || !appSettings) {
      return;
    }
    const parentDir = getParentDir(initialFileToOpen);
    if (currentFolderPath !== parentDir) {
      setLibrary({ rootPath: parentDir });
      handleSelectSubfolder(parentDir, true);
      return;
    }
    const isImageInList = imageList.some((image) => image.path === initialFileToOpen);
    if (isImageInList) {
      handleImageSelect(initialFileToOpen);
      setProcess({ initialFileToOpen: null });
    } else if (!isViewLoading) {
      console.warn(`'open-with-file' target ${initialFileToOpen} not found in its directory after loading. Aborting.`);
      setProcess({ initialFileToOpen: null });
    }
  }, [
    initialFileToOpen,
    appSettings,
    currentFolderPath,
    imageList,
    isViewLoading,
    handleSelectSubfolder,
    handleImageSelect,
    setLibrary,
    setProcess,
  ]);

  const handleGoHome = () => {
    setLibrary({
      rootPath: null,
      currentFolderPath: null,
      imageList: [],
      imageRatings: {},
      folderTree: null,
      multiSelectedPaths: [],
      libraryActivePath: null,
      expandedFolders: new Set(),
    });
    setUI({ isLibraryExportPanelVisible: false });
  };

  const handleMultiSelectClick = (path: string, event: any, options: MultiSelectOptions) => {
    const { ctrlKey, metaKey, shiftKey } = event;
    const isCtrlPressed = ctrlKey || metaKey;
    const { shiftAnchor, onSimpleClick, updateLibraryActivePath } = options;

    if (shiftKey && shiftAnchor) {
      const anchorIndex = sortedImageList.findIndex((f) => f.path === shiftAnchor);
      const currentIndex = sortedImageList.findIndex((f) => f.path === path);

      if (anchorIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(anchorIndex, currentIndex);
        const end = Math.max(anchorIndex, currentIndex);
        const range = sortedImageList.slice(start, end + 1).map((f: ImageFile) => f.path);
        const baseSelection = isCtrlPressed ? multiSelectedPaths : [];
        const newSelection = Array.from(new Set([...baseSelection, ...range]));

        setLibrary({ multiSelectedPaths: newSelection, selectionAnchorPath: path });
        if (updateLibraryActivePath) {
          setLibrary({ libraryActivePath: path });
        }
      }
    } else if (isCtrlPressed) {
      const newSelection = new Set(multiSelectedPaths);
      if (newSelection.has(path)) {
        newSelection.delete(path);
      } else {
        newSelection.add(path);
      }

      const newSelectionArray = Array.from(newSelection);
      setLibrary({ multiSelectedPaths: newSelectionArray, selectionAnchorPath: path });

      if (updateLibraryActivePath) {
        if (newSelectionArray.includes(path)) {
          setLibrary({ libraryActivePath: path });
        } else if (newSelectionArray.length > 0) {
          setLibrary({ libraryActivePath: newSelectionArray[newSelectionArray.length - 1] });
        } else {
          setLibrary({ libraryActivePath: null });
        }
      }
    } else {
      onSimpleClick(path);
      setLibrary({ selectionAnchorPath: path });
    }
  };

  const handleLibraryImageSingleClick = (path: string, event: any) => {
    handleMultiSelectClick(path, event, {
      shiftAnchor: selectionAnchorPath ?? libraryActivePath,
      updateLibraryActivePath: true,
      onSimpleClick: (p: any) => {
        setLibrary({ multiSelectedPaths: [p], libraryActivePath: p, selectionAnchorPath: p });
      },
    });
  };

  const handleImageClick = (path: string, event: any) => {
    const inEditor = !!selectedImage;
    handleMultiSelectClick(path, event, {
      shiftAnchor: selectionAnchorPath ?? (inEditor ? selectedImage.path : libraryActivePath),
      updateLibraryActivePath: !inEditor,
      onSimpleClick: (p: string) => {
        handleImageSelect(p);
        setLibrary({ selectionAnchorPath: p });
      },
    });
  };

  const handleClearSelection = () => {
    if (selectedImage) {
      setLibrary({ multiSelectedPaths: [selectedImage.path] });
    } else {
      setLibrary({ multiSelectedPaths: [], libraryActivePath: null });
    }
  };

  const handleRenameFiles = useCallback(
    async (paths: Array<string>) => {
      if (paths && paths.length > 0) {
        setUI({ renameTargetPaths: paths, isRenameFileModalOpen: true });
      }
    },
    [setUI],
  );

  const handleResetAdjustments = useCallback(
    (paths?: Array<string>) => {
      const pathsToReset = paths || multiSelectedPaths;
      if (pathsToReset.length === 0) {
        return;
      }

      pathsToReset.forEach((p) => imageCacheRef.current.delete(p));
      debouncedSetHistory.cancel();

      invoke(Invokes.ResetAdjustmentsForPaths, { paths: pathsToReset })
        .then(() => {
          if (libraryActivePath && pathsToReset.includes(libraryActivePath)) {
            setLibrary({ libraryActiveAdjustments: { ...INITIAL_ADJUSTMENTS } });
          }
          if (selectedImage && pathsToReset.includes(selectedImage.path)) {
            const originalAspectRatio =
              selectedImage.width && selectedImage.height ? selectedImage.width / selectedImage.height : null;

            resetHistory({
              ...INITIAL_ADJUSTMENTS,
              aspectRatio: originalAspectRatio,
              aiPatches: [],
            });
          }
        })
        .catch((err) => {
          console.error('Failed to reset adjustments:', err);
          setError(`Failed to reset adjustments: ${err}`);
        });
    },
    [multiSelectedPaths, libraryActivePath, selectedImage, resetHistory, debouncedSetHistory, setLibrary],
  );

  const handleImportClick = useCallback(
    async (targetPath: string) => {
      try {
        const nonRaw = supportedTypes?.nonRaw || [];
        const raw = supportedTypes?.raw || [];

        const expandExtensions = (exts: string[]) => {
          return Array.from(new Set(exts.flatMap((ext) => [ext.toLowerCase(), ext.toUpperCase()])));
        };

        const processedNonRaw = expandExtensions(nonRaw);
        const processedRaw = expandExtensions(raw);
        const allImageExtensions = [...processedNonRaw, ...processedRaw];

        const typeFilters = isAndroid
          ? []
          : [
              {
                name: 'All Supported Images',
                extensions: allImageExtensions,
              },
              {
                name: 'RAW Images',
                extensions: processedRaw,
              },
              {
                name: 'Standard Images (JPEG, PNG, etc.)',
                extensions: processedNonRaw,
              },
              {
                name: 'All Files',
                extensions: ['*'],
              },
            ];

        const selected = await open({
          filters: typeFilters,
          multiple: true,
          title: 'Select files to import',
        });

        if (Array.isArray(selected) && selected.length > 0) {
          const invalidExtensions = new Set<string>();
          const allowedExtensions = new Set(allImageExtensions.map((e) => e.toLowerCase()));

          const resolvedFiles = await Promise.all(
            selected.map(async (path) => {
              if (isAndroid) {
                try {
                  return await invoke<string>('resolve_android_content_uri_name', { uriStr: path });
                } catch (e) {
                  console.error('Failed to resolve URI:', e);
                  return path;
                }
              }
              return path;
            }),
          );

          const validFiles = selected.filter((originalPath, index) => {
            const resolvedName = resolvedFiles[index];
            const ext = resolvedName.split('.').pop()?.toLowerCase() || 'unknown';

            if (!allowedExtensions.has(ext)) {
              invalidExtensions.add(`.${ext}`);
              return false;
            }
            return true;
          });

          if (invalidExtensions.size > 0) {
            const extList = Array.from(invalidExtensions).join(', ');
            toast.error(`Unsupported file format(s) detected: ${extList}`);
            return;
          }

          if (isAndroid) {
            await startImportFiles(validFiles, targetPath, DEFAULT_IMPORT_SETTINGS);
            return;
          }

          setUI({ importSourcePaths: validFiles, importTargetFolder: targetPath, isImportModalOpen: true });
        }
      } catch (err) {
        console.error('Failed to open file dialog for import:', err);
      }
    },
    [supportedTypes, isAndroid, startImportFiles, setUI],
  );

  const handleEditorContextMenu = (event: any) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedImage) return;

    const handleCreateVirtualCopy = async (sourcePath: string) => {
      try {
        await invoke(Invokes.CreateVirtualCopy, { sourceVirtualPath: sourcePath });
        await refreshImageList();
      } catch (err) {
        console.error('Failed to create virtual copy:', err);
        setError(`Failed to create virtual copy: ${err}`);
      }
    };

    const commonTags = getCommonTags([selectedImage.path]);

    const options: Array<Option> = [
      {
        label: 'Export Image',
        icon: FileInput,
        onClick: () => {
          setRightPanel(Panel.Export, RIGHT_PANEL_ORDER);
        },
      },
      { type: OPTION_SEPARATOR },
      { label: 'Undo', icon: Undo, onClick: undo, disabled: !canUndo },
      { label: 'Redo', icon: Redo, onClick: redo, disabled: !canRedo },
      { type: OPTION_SEPARATOR },
      { label: 'Copy Adjustments', icon: Copy, onClick: handleCopyAdjustments },
      {
        label: 'Paste Adjustments',
        icon: ClipboardPaste,
        onClick: handlePasteAdjustments,
        disabled: copiedAdjustments === null,
      },
      {
        label: 'Productivity',
        icon: Gauge,
        submenu: [
          {
            label: 'Auto Adjust Image',
            icon: Aperture,
            onClick: handleAutoAdjustments,
            disabled: !selectedImage?.isReady,
          },
          {
            label: 'Denoise Image',
            icon: Grip,
            onClick: () => {
              setUI({
                denoiseModalState: {
                  isOpen: true,
                  isProcessing: false,
                  previewBase64: null,
                  error: null,
                  targetPaths: [selectedImage.path],
                  progressMessage: null,
                  isRaw: selectedImage?.isRaw || false,
                },
              });
            },
          },
          {
            label: 'Convert Negative',
            icon: Film,
            onClick: () => {
              if (selectedImage) {
                setUI({ negativeModalState: { isOpen: true, targetPaths: [selectedImage.path] } });
              }
            },
          },
          {
            disabled: true,
            icon: SquaresUnite,
            label: 'Stitch Panorama',
          },
          {
            disabled: true,
            icon: Images,
            label: 'Merge to HDR',
          },
          {
            icon: LayoutTemplate,
            label: 'Frame Image',
            onClick: () => {
              setUI({ collageModalState: { isOpen: true, sourceImages: [selectedImage] } });
            },
          },
          {
            label: 'Cull Image',
            icon: Users,
            disabled: true,
          },
        ],
      },
      { type: OPTION_SEPARATOR },
      {
        label: 'Rating',
        icon: Star,
        submenu: [0, 1, 2, 3, 4, 5].map((rating: number) => ({
          label: rating === 0 ? 'No Rating' : `${rating} Star${rating !== 1 ? 's' : ''}`,
          onClick: () => handleRate(rating),
        })),
      },
      {
        label: 'Color Label',
        icon: Palette,
        submenu: [
          { label: 'No Label', onClick: () => handleSetColorLabel(null) },
          ...COLOR_LABELS.map((label: Color) => ({
            label: label.name.charAt(0).toUpperCase() + label.name.slice(1),
            color: label.color,
            onClick: () => handleSetColorLabel(label.name),
          })),
        ],
      },
      {
        label: 'Tagging',
        icon: Tag,
        submenu: [
          {
            customComponent: TaggingSubMenu,
            customProps: {
              paths: [selectedImage.path],
              initialTags: commonTags,
              onTagsChanged: handleTagsChanged,
              appSettings,
            },
          },
        ],
      },
      { type: OPTION_SEPARATOR },
      {
        label: 'Reset Adjustments',
        icon: RotateCcw,
        submenu: [
          { label: 'Cancel', icon: X, onClick: () => {} },
          {
            label: 'Confirm Reset',
            icon: Check,
            isDestructive: true,
            onClick: () => {
              debouncedSetHistory.cancel();
              const originalAspectRatio =
                selectedImage.width && selectedImage.height ? selectedImage.width / selectedImage.height : null;
              resetHistory({
                ...INITIAL_ADJUSTMENTS,
                aspectRatio: originalAspectRatio,
                aiPatches: [],
              });
            },
          },
        ],
      },
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  const handleThumbnailContextMenu = (event: any, path: string) => {
    event.preventDefault();
    event.stopPropagation();

    const isTargetInSelection = multiSelectedPaths.includes(path);
    let finalSelection;

    if (!isTargetInSelection) {
      finalSelection = [path];
      setLibrary({ multiSelectedPaths: [path] });
      if (!selectedImage) {
        setLibrary({ libraryActivePath: path });
      }
    } else {
      finalSelection = multiSelectedPaths;
    }

    const commonTags = getCommonTags(finalSelection);

    const selectionCount = finalSelection.length;
    const isSingleSelection = selectionCount === 1;
    const isEditingThisImage = selectedImage?.path === path;
    const deleteLabel = isSingleSelection ? 'Delete Image' : `Delete ${selectionCount} Images`;
    const exportLabel = isSingleSelection ? 'Export Image' : `Export ${selectionCount} Images`;

    const selectionHasVirtualCopies =
      isSingleSelection &&
      !finalSelection[0].includes('?vc=') &&
      imageList.some((image) => image.path.startsWith(`${finalSelection[0]}?vc=`));

    const hasAssociatedFiles = finalSelection.some((selectedPath) => {
      const lastDotIndex = selectedPath.lastIndexOf('.');
      if (lastDotIndex === -1) return false;
      const basePath = selectedPath.substring(0, lastDotIndex);
      return imageList.some((image) => image.path.startsWith(basePath + '.') && image.path !== selectedPath);
    });

    let deleteSubmenu;
    if (selectionHasVirtualCopies) {
      deleteSubmenu = [
        { label: 'Cancel', icon: X, onClick: () => {} },
        {
          label: 'Confirm Delete + Virtual Copies',
          icon: Check,
          isDestructive: true,
          onClick: () => executeDelete(finalSelection, { includeAssociated: false }),
        },
      ];
    } else if (hasAssociatedFiles) {
      deleteSubmenu = [
        { label: 'Cancel', icon: X, onClick: () => {} },
        {
          label: 'Delete Selected Only',
          icon: Check,
          isDestructive: true,
          onClick: () => executeDelete(finalSelection, { includeAssociated: false }),
        },
        {
          label: 'Delete + Associated',
          icon: Check,
          isDestructive: true,
          onClick: () => executeDelete(finalSelection, { includeAssociated: true }),
        },
      ];
    } else {
      deleteSubmenu = [
        { label: 'Cancel', icon: X, onClick: () => {} },
        {
          label: 'Confirm Delete',
          icon: Check,
          isDestructive: true,
          onClick: () => executeDelete(finalSelection, { includeAssociated: false }),
        },
      ];
    }

    const deleteOption = {
      label: deleteLabel,
      icon: Trash2,
      isDestructive: true,
      submenu: deleteSubmenu,
    };

    const pasteLabel = isSingleSelection ? 'Paste Adjustments' : `Paste Adjustments to ${selectionCount} Images`;
    const resetLabel = isSingleSelection ? 'Reset Adjustments' : `Reset Adjustments on ${selectionCount} Images`;
    const copyLabel = isSingleSelection ? 'Copy Image' : `Copy ${selectionCount} Images`;
    const autoAdjustLabel = isSingleSelection ? 'Auto Adjust Image' : `Auto Adjust Images`;
    const renameLabel = isSingleSelection ? 'Rename Image' : `Rename ${selectionCount} Images`;
    const cullLabel = isSingleSelection ? 'Cull Image' : `Cull Images`;
    const collageLabel = isSingleSelection ? 'Frame Image' : 'Create Collage';
    const stitchLabel = 'Stitch Panorama';
    const conversionLabel = isSingleSelection ? 'Convert Negative' : 'Convert Negatives';
    const denoiseLabel = isSingleSelection ? 'Denoise Image' : 'Denoise Images';
    const mergeLabel = `Merge to HDR`;

    const handleCreateVirtualCopy = async (sourcePath: string) => {
      try {
        await invoke(Invokes.CreateVirtualCopy, { sourceVirtualPath: sourcePath });
        await refreshImageList();
      } catch (err) {
        console.error('Failed to create virtual copy:', err);
        setError(`Failed to create virtual copy: ${err}`);
      }
    };

    const handleApplyAutoAdjustmentsToSelection = () => {
      if (finalSelection.length === 0) return;
      finalSelection.forEach((p) => imageCacheRef.current.delete(p));

      invoke(Invokes.ApplyAutoAdjustmentsToPaths, { paths: finalSelection })
        .then(async () => {
          if (selectedImage && finalSelection.includes(selectedImage.path)) {
            const metadata: Metadata = await invoke(Invokes.LoadMetadata, {
              path: selectedImage.path,
            });
            if (metadata.adjustments && !metadata.adjustments.is_null) {
              const normalized = normalizeLoadedAdjustments(metadata.adjustments);
              setLiveAdjustments(normalized);
              resetHistory(normalized);
            }
          }
          if (libraryActivePath && finalSelection.includes(libraryActivePath)) {
            const metadata: Metadata = await invoke(Invokes.LoadMetadata, {
              path: libraryActivePath,
            });
            if (metadata.adjustments && !metadata.adjustments.is_null) {
              const normalized = normalizeLoadedAdjustments(metadata.adjustments);
              setLibrary({ libraryActiveAdjustments: normalized });
            }
          }
        })
        .catch((err) => {
          console.error('Failed to apply auto adjustments to paths:', err);
          setError(`Failed to apply auto adjustments: ${err}`);
        });
    };

    const onExportClick = () => {
      if (selectedImage) {
        if (selectedImage.path !== path) {
          handleImageSelect(path);
        }
        setLibrary({ multiSelectedPaths: finalSelection });
        setRightPanel(Panel.Export, RIGHT_PANEL_ORDER);
      } else {
        setLibrary({ multiSelectedPaths: finalSelection });
        setUI({ isLibraryExportPanelVisible: true });
      }
    };

    const options = [
      ...(!isEditingThisImage
        ? [
            {
              disabled: !isSingleSelection,
              icon: Edit,
              label: 'Edit Image',
              onClick: () => handleImageSelect(finalSelection[0]),
            },
            {
              icon: FileInput,
              label: exportLabel,
              onClick: onExportClick,
            },
            { type: OPTION_SEPARATOR },
          ]
        : [
            {
              icon: FileInput,
              label: exportLabel,
              onClick: onExportClick,
            },
            { type: OPTION_SEPARATOR },
          ]),
      {
        disabled: !isSingleSelection,
        icon: Copy,
        label: 'Copy Adjustments',
        onClick: async () => {
          try {
            const metadata: any = await invoke(Invokes.LoadMetadata, { path: finalSelection[0] });
            const sourceAdjustments =
              metadata.adjustments && !metadata.adjustments.is_null
                ? { ...INITIAL_ADJUSTMENTS, ...metadata.adjustments }
                : INITIAL_ADJUSTMENTS;
            const adjustmentsToCopy: any = {};
            for (const key of COPYABLE_ADJUSTMENT_KEYS) {
              if (Object.prototype.hasOwnProperty.call(sourceAdjustments, key)) {
                adjustmentsToCopy[key] = sourceAdjustments[key];
              }
            }
            setCopiedAdjustments(adjustmentsToCopy);
            setProcess({ isCopied: true });
          } catch (err) {
            console.error('Failed to load metadata for copy:', err);
            setError(`Failed to copy adjustments: ${err}`);
          }
        },
      },
      {
        disabled: copiedAdjustments === null,
        icon: ClipboardPaste,
        label: pasteLabel,
        onClick: () => handlePasteAdjustments(finalSelection),
      },
      {
        label: 'Productivity',
        icon: Gauge,
        submenu: [
          {
            label: autoAdjustLabel,
            icon: Aperture,
            onClick: handleApplyAutoAdjustmentsToSelection,
          },
          {
            label: denoiseLabel,
            icon: Grip,
            disabled: finalSelection.length === 0,
            onClick: () => {
              setUI({
                denoiseModalState: {
                  isOpen: true,
                  isProcessing: false,
                  previewBase64: null,
                  error: null,
                  targetPaths: finalSelection,
                  progressMessage: null,
                  isRaw: selectedImage?.isRaw || false,
                },
              });
            },
          },
          {
            label: conversionLabel,
            icon: Film,
            disabled: selectionCount === 0,
            onClick: () => {
              setUI({ negativeModalState: { isOpen: true, targetPaths: finalSelection } });
            },
          },
          {
            disabled: selectionCount < 2 || selectionCount > 30,
            icon: SquaresUnite,
            label: stitchLabel,
            onClick: () => {
              setUI({
                panoramaModalState: {
                  error: null,
                  finalImageBase64: null,
                  isOpen: true,
                  isProcessing: false,
                  progressMessage: null,
                  stitchingSourcePaths: finalSelection,
                },
              });
            },
          },
          {
            disabled: selectionCount < 2 || selectionCount > 9,
            icon: Images,
            label: mergeLabel,
            onClick: () => {
              setUI({
                hdrModalState: {
                  error: null,
                  finalImageBase64: null,
                  isOpen: true,
                  isProcessing: false,
                  progressMessage: null,
                  stitchingSourcePaths: finalSelection,
                },
              });
            },
          },
          {
            icon: LayoutTemplate,
            label: collageLabel,
            onClick: () => {
              const imagesForCollage = imageList.filter((img) => finalSelection.includes(img.path));
              setUI({ collageModalState: { isOpen: true, sourceImages: imagesForCollage } });
            },
            disabled: selectionCount === 0 || selectionCount > 9,
          },
          {
            label: cullLabel,
            icon: Users,
            onClick: () =>
              setUI({
                cullingModalState: {
                  isOpen: true,
                  progress: null,
                  suggestions: null,
                  error: null,
                  pathsToCull: finalSelection,
                },
              }),
            disabled: selectionCount < 2,
          },
        ],
      },
      { type: OPTION_SEPARATOR },
      {
        label: copyLabel,
        icon: Copy,
        onClick: () => {
          setProcess({ copiedFilePaths: finalSelection, isCopied: true });
        },
      },
      {
        icon: CopyPlus,
        label: 'Duplicate Image',
        disabled: !isSingleSelection,
        submenu: [
          {
            label: 'Physical Copy',
            icon: Copy,
            onClick: async () => {
              try {
                await invoke(Invokes.DuplicateFile, { path: finalSelection[0] });
                await refreshImageList();
              } catch (err) {
                console.error('Failed to duplicate file:', err);
                setError(`Failed to duplicate file: ${err}`);
              }
            },
          },
          {
            label: 'Virtual Copy',
            icon: CopyPlus,
            onClick: () => handleCreateVirtualCopy(finalSelection[0]),
          },
        ],
      },
      { icon: FileEdit, label: renameLabel, onClick: () => handleRenameFiles(finalSelection) },
      { type: OPTION_SEPARATOR },
      {
        icon: Star,
        label: 'Rating',
        submenu: [0, 1, 2, 3, 4, 5].map((rating: number) => ({
          label: rating === 0 ? 'No Rating' : `${rating} Star${rating !== 1 ? 's' : ''}`,
          onClick: () => handleRate(rating, finalSelection),
        })),
      },
      {
        label: 'Color Label',
        icon: Palette,
        submenu: [
          { label: 'No Label', onClick: () => handleSetColorLabel(null, finalSelection) },
          ...COLOR_LABELS.map((label: Color) => ({
            label: label.name.charAt(0).toUpperCase() + label.name.slice(1),
            color: label.color,
            onClick: () => handleSetColorLabel(label.name, finalSelection),
          })),
        ],
      },
      {
        label: 'Tagging',
        icon: Tag,
        submenu: [
          {
            customComponent: TaggingSubMenu,
            customProps: {
              paths: finalSelection,
              initialTags: commonTags,
              onTagsChanged: handleTagsChanged,
              appSettings,
            },
          },
        ],
      },
      { type: OPTION_SEPARATOR },
      {
        disabled: !isSingleSelection,
        icon: Folder,
        label: 'Show in File Explorer',
        onClick: () => {
          invoke(Invokes.ShowInFinder, { path: finalSelection[0] }).catch((err) =>
            setError(`Could not show file in explorer: ${err}`),
          );
        },
      },
      {
        label: resetLabel,
        icon: RotateCcw,
        submenu: [
          { label: 'Cancel', icon: X, onClick: () => {} },
          {
            label: 'Confirm Reset',
            icon: Check,
            isDestructive: true,
            onClick: () => handleResetAdjustments(finalSelection),
          },
        ],
      },
      deleteOption,
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  const handleFolderTreeContextMenu = (event: any, path: string, isCurrentlyPinned?: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    const targetPath = path || rootPath;
    if (!targetPath) {
      return;
    }
    const isRoot = targetPath === rootPath;
    const numCopied = copiedFilePaths.length;
    const copyPastedLabel = numCopied === 1 ? 'Copy image here' : `Copy ${numCopied} images here`;
    const movePastedLabel = numCopied === 1 ? 'Move image here' : `Move ${numCopied} images here`;

    const pinOption = isCurrentlyPinned
      ? {
          icon: PinOff,
          label: 'Unpin Folder',
          onClick: () => handleTogglePinFolder(targetPath),
        }
      : {
          icon: Pin,
          label: 'Pin Folder',
          onClick: () => handleTogglePinFolder(targetPath),
        };

    const options = [
      pinOption,
      { type: OPTION_SEPARATOR },
      {
        icon: FolderPlus,
        label: 'New Folder',
        onClick: () => {
          setUI({ folderActionTarget: targetPath, isCreateFolderModalOpen: true });
        },
      },
      {
        disabled: isRoot,
        icon: FileEdit,
        label: 'Rename Folder',
        onClick: () => {
          setUI({ folderActionTarget: targetPath, isRenameFolderModalOpen: true });
        },
      },
      { type: OPTION_SEPARATOR },
      {
        disabled: copiedFilePaths.length === 0,
        icon: ClipboardPaste,
        label: 'Paste',
        submenu: [
          {
            label: copyPastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.CopyFiles, { sourcePaths: copiedFilePaths, destinationFolder: targetPath });
                if (targetPath === currentFolderPath) handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to copy files: ${err}`);
              }
            },
          },
          {
            label: movePastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.MoveFiles, { sourcePaths: copiedFilePaths, destinationFolder: targetPath });
                setProcess({ copiedFilePaths: [] });
                setLibrary({ multiSelectedPaths: [] });
                refreshAllFolderTrees();
                handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to move files: ${err}`);
              }
            },
          },
        ],
      },
      { icon: FolderInput, label: 'Import Images', onClick: () => handleImportClick(targetPath) },
      { type: OPTION_SEPARATOR },
      {
        icon: Folder,
        label: 'Show in File Explorer',
        onClick: () =>
          invoke(Invokes.ShowInFinder, { path: targetPath }).catch((err) => setError(`Could not show folder: ${err}`)),
      },
      ...(path
        ? [
            {
              disabled: isRoot,
              icon: Trash2,
              isDestructive: true,
              label: 'Delete Folder',
              submenu: [
                { label: 'Cancel', icon: X, onClick: () => {} },
                {
                  label: 'Confirm',
                  icon: Check,
                  isDestructive: true,
                  onClick: async () => {
                    try {
                      await invoke(Invokes.DeleteFolder, { path: targetPath });
                      if (currentFolderPath?.startsWith(targetPath)) await handleSelectSubfolder(rootPath);
                      refreshAllFolderTrees();
                    } catch (err) {
                      setError(`Failed to delete folder: ${err}`);
                    }
                  },
                },
              ],
            },
          ]
        : []),
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  const handleMainLibraryContextMenu = (event: any) => {
    event.preventDefault();
    event.stopPropagation();
    const numCopied = copiedFilePaths.length;
    const copyPastedLabel = numCopied === 1 ? 'Copy image here' : `Copy ${numCopied} images here`;
    const movePastedLabel = numCopied === 1 ? 'Move image here' : `Move ${numCopied} images here`;

    const options = [
      {
        label: 'Refresh Folder',
        icon: RefreshCw,
        onClick: handleLibraryRefresh,
      },
      { type: OPTION_SEPARATOR },
      {
        label: 'Paste',
        icon: ClipboardPaste,
        disabled: copiedFilePaths.length === 0,
        submenu: [
          {
            label: copyPastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.CopyFiles, { sourcePaths: copiedFilePaths, destinationFolder: currentFolderPath });
                handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to copy files: ${err}`);
              }
            },
          },
          {
            label: movePastedLabel,
            onClick: async () => {
              try {
                await invoke(Invokes.MoveFiles, { sourcePaths: copiedFilePaths, destinationFolder: currentFolderPath });
                setProcess({ copiedFilePaths: [] });
                setLibrary({ multiSelectedPaths: [] });
                refreshAllFolderTrees();
                handleLibraryRefresh();
              } catch (err) {
                setError(`Failed to move files: ${err}`);
              }
            },
          },
        ],
      },
      {
        icon: FolderInput,
        label: 'Import Images',
        onClick: () => handleImportClick(currentFolderPath as string),
        disabled: !currentFolderPath,
      },
    ];
    showContextMenu(event.clientX, event.clientY, options);
  };

  const renderFolderTree = () => {
    if (!rootPath) return null;

    return (
      <div
        className={clsx(
          'flex h-full overflow-hidden shrink-0',
          !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
        )}
        style={{
          maxWidth: isFullScreen ? '0px' : '1000px',
          opacity: isFullScreen ? 0 : 1,
        }}
      >
        <FolderTree
          expandedFolders={expandedFolders}
          isLoading={isTreeLoading}
          isResizing={isResizing}
          isVisible={uiVisibility.folderTree}
          onContextMenu={handleFolderTreeContextMenu}
          onFolderSelect={(path) => handleSelectSubfolder(path, false)}
          onToggleFolder={handleToggleFolder}
          selectedPath={currentFolderPath}
          setIsVisible={(value: boolean) =>
            setUI((state) => ({ uiVisibility: { ...state.uiVisibility, folderTree: value } }))
          }
          style={{ width: uiVisibility.folderTree ? `${leftPanelWidth}px` : '32px' }}
          tree={folderTree}
          pinnedFolderTrees={pinnedFolderTrees}
          pinnedFolders={pinnedFolders}
          activeSection={activeTreeSection}
          onActiveSectionChange={handleActiveTreeSectionChange}
          showImageCounts={appSettings?.enableFolderImageCounts ?? false}
          isInstantTransition={isInstantTransition}
        />
        <Resizer direction={Orientation.Vertical} onMouseDown={createResizeHandler('left', leftPanelWidth)} />
      </div>
    );
  };

  const renderLibraryView = () => (
    <div className="flex flex-row grow h-full min-h-0">
      <div className="flex-1 flex flex-col min-w-0 gap-2">
        {activeView === 'community' ? (
          <CommunityPage
            onBackToLibrary={() => setUI({ activeView: 'library' })}
            supportedTypes={supportedTypes}
            imageList={sortedImageList}
            currentFolderPath={currentFolderPath}
          />
        ) : (
          <MainLibrary
            activePath={libraryActivePath}
            aiModelDownloadStatus={aiModelDownloadStatus}
            appSettings={appSettings}
            currentFolderPath={currentFolderPath}
            imageList={sortedImageList}
            imageRatings={imageRatings}
            importState={importState}
            indexingProgress={indexingProgress}
            isIndexing={isIndexing}
            isLoading={isViewLoading}
            isTreeLoading={isTreeLoading}
            isAndroid={isAndroid}
            libraryViewMode={libraryViewMode}
            multiSelectedPaths={multiSelectedPaths}
            onClearSelection={handleClearSelection}
            onContextMenu={handleThumbnailContextMenu}
            onContinueSession={handleContinueSession}
            onEmptyAreaContextMenu={handleMainLibraryContextMenu}
            onGoHome={handleGoHome}
            onImageClick={handleLibraryImageSingleClick}
            onImageDoubleClick={handleImageSelect}
            onImportClick={() => handleImportClick(currentFolderPath as string)}
            onLibraryRefresh={handleLibraryRefresh}
            onOpenFolder={handleOpenFolder}
            onSettingsChange={handleSettingsChange}
            onThumbnailAspectRatioChange={setThumbnailAspectRatio}
            onThumbnailSizeChange={setThumbnailSize}
            onRequestThumbnails={requestThumbnails}
            rootPath={rootPath}
            setLibraryViewMode={setLibraryViewMode}
            theme={theme}
            thumbnailAspectRatio={thumbnailAspectRatio}
            thumbnails={thumbnails}
            thumbnailProgress={thumbnailProgress}
            thumbnailSize={thumbnailSize}
            onNavigateToCommunity={() => setUI({ activeView: 'community' })}
          />
        )}
        {rootPath && (
          <BottomBar
            isCopied={isCopied}
            isCopyDisabled={multiSelectedPaths.length !== 1}
            isExportDisabled={multiSelectedPaths.length === 0}
            isLibraryView={true}
            isPasted={isPasted}
            isPasteDisabled={copiedAdjustments === null || multiSelectedPaths.length === 0}
            isRatingDisabled={multiSelectedPaths.length === 0}
            isResetDisabled={multiSelectedPaths.length === 0}
            multiSelectedPaths={multiSelectedPaths}
            onCopy={handleCopyAdjustments}
            onExportClick={() =>
              setUI((state) => ({ isLibraryExportPanelVisible: !state.isLibraryExportPanelVisible }))
            }
            onOpenCopyPasteSettings={() => setUI({ isCopyPasteSettingsModalOpen: true })}
            onPaste={() => handlePasteAdjustments()}
            onRate={handleRate}
            onReset={() => handleResetAdjustments()}
            rating={imageRatings[libraryActivePath || ''] || 0}
            thumbnailAspectRatio={thumbnailAspectRatio}
            totalImages={imageList.length}
          />
        )}
      </div>
    </div>
  );

  const handleSetIsStraighten = useCallback((v: boolean) => setEditor({ isStraightenActive: v }), [setEditor]);
  const handleSetIsRotation = useCallback((v: boolean) => setEditor({ isRotationActive: v }), [setEditor]);
  const handleSetOverlayRotation = useCallback(
    (v: any) =>
      setEditor((state) => ({
        overlayRotation: typeof v === 'function' ? v(state.overlayRotation) : v,
      })),
    [setEditor],
  );
  const handleSetOverlayMode = useCallback((v: OverlayMode) => setEditor({ overlayMode: v }), [setEditor]);
  const handleLiveRotationChange = useCallback((v: number | null) => setEditor({ liveRotation: v }), [setEditor]);

  const handleSelectContainer = useCallback(
    (id: string | null) => setEditor({ activeMaskContainerId: id }),
    [setEditor],
  );
  const handleSelectMask = useCallback((id: string | null) => setEditor({ activeMaskId: id }), [setEditor]);
  const handleSetBrushSettings = useCallback((v: any) => setEditor({ brushSettings: v }), [setEditor]);
  const handleSetCopiedMask = useCallback((v: any) => setEditor({ copiedMask: v }), [setEditor]);
  const handleSetMaskControlHovered = useCallback((v: boolean) => setEditor({ isMaskControlHovered: v }), [setEditor]);

  const handleSelectAiPatch = useCallback(
    (id: string | null) => setEditor({ activeAiPatchContainerId: id }),
    [setEditor],
  );
  const handleSelectAiSubMask = useCallback((id: string | null) => setEditor({ activeAiSubMaskId: id }), [setEditor]);

  const renderMainView = () => {
    const panelVariants: any = {
      animate: (direction: number) => ({
        opacity: 1,
        y: 0,
        transition: { duration: direction === 0 ? 0 : 0.2, ease: 'circOut' },
      }),
      exit: (direction: number) => ({
        opacity: direction === 0 ? 1 : 0.2,
        y: direction === 0 ? 0 : direction > 0 ? -20 : 20,
        transition: { duration: direction === 0 ? 0 : 0.1, ease: 'circIn' },
      }),
      initial: (direction: number) => ({
        opacity: direction === 0 ? 1 : 0.2,
        y: direction === 0 ? 0 : direction > 0 ? 20 : -20,
      }),
    };

    if (selectedImage) {
      const editorNode = (
        <Editor
          onBackToLibrary={handleBackToLibrary}
          onContextMenu={handleEditorContextMenu}
          onGenerateAiMask={handleGenerateAiMask}
          onQuickErase={handleQuickErase}
          setAdjustments={setAdjustments}
          transformWrapperRef={transformWrapperRef}
        />
      );

      const editorBottomBarComponent = (
        <BottomBar
          filmstripHeight={bottomPanelHeight}
          imageList={sortedImageList}
          imageRatings={imageRatings}
          isCopied={isCopied}
          isCopyDisabled={!selectedImage}
          isFilmstripVisible={uiVisibility.filmstrip}
          isLoading={isViewLoading}
          isPasted={isPasted}
          isPasteDisabled={copiedAdjustments === null}
          isRatingDisabled={!selectedImage}
          isResizing={isResizing}
          multiSelectedPaths={multiSelectedPaths}
          displaySize={displaySize}
          originalSize={originalSize}
          baseRenderSize={baseRenderSize}
          onClearSelection={handleClearSelection}
          onContextMenu={handleThumbnailContextMenu}
          onCopy={handleCopyAdjustments}
          onOpenCopyPasteSettings={() => setUI({ isCopyPasteSettingsModalOpen: true })}
          onImageSelect={handleImageClick}
          onPaste={() => handlePasteAdjustments()}
          onRate={handleRate}
          onRequestThumbnails={requestThumbnails}
          onZoomChange={handleZoomChange}
          rating={imageRatings[selectedImage?.path || ''] || 0}
          selectedImage={selectedImage}
          setIsFilmstripVisible={(value: boolean) =>
            setUI((state) => ({ uiVisibility: { ...state.uiVisibility, filmstrip: value } }))
          }
          showFilmstrip={!isCompactPortrait}
          showZoomControls={!isAndroid}
          thumbnailAspectRatio={thumbnailAspectRatio}
          thumbnails={thumbnails}
          zoom={zoom}
          totalImages={sortedImageList.length}
        />
      );

      const editorBottomBarNode = (
        <div
          className={clsx(
            'flex flex-col w-full overflow-hidden shrink-0',
            !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
          )}
          style={{
            maxHeight: isFullScreen ? '0px' : '500px',
            opacity: isFullScreen ? 0 : 1,
          }}
        >
          {!isCompactPortrait && (
            <Resizer
              direction={Orientation.Horizontal}
              onMouseDown={createResizeHandler('bottom', bottomPanelHeight)}
            />
          )}
          {editorBottomBarComponent}
        </div>
      );

      const editorRightPanelContent = (
        <AnimatePresence mode="wait" custom={slideDirection}>
          {activeRightPanel && (
            <motion.div
              animate="animate"
              className="h-full w-full"
              custom={slideDirection}
              exit="exit"
              initial="initial"
              key={renderedRightPanel}
              variants={panelVariants}
            >
              {renderedRightPanel === Panel.Adjustments && (
                <Controls
                  handleAutoAdjustments={handleAutoAdjustments}
                  handleLutSelect={handleLutSelect}
                  setAdjustments={setAdjustments}
                />
              )}
              {renderedRightPanel === Panel.Metadata && (
                <MetadataPanel
                  selectedImage={selectedImage}
                  multiSelectedPaths={multiSelectedPaths}
                  rating={imageRatings[selectedImage.path] || 0}
                  tags={imageList.find((img) => img.path === selectedImage.path)?.tags || []}
                  onRate={handleRate}
                  onUpdateExif={handleUpdateExif}
                  onSetColorLabel={handleSetColorLabel}
                  onTagsChanged={handleTagsChanged}
                  appSettings={appSettings}
                  liveThumbnailUrl={thumbnails[selectedImage.path]}
                />
              )}
              {renderedRightPanel === Panel.Crop && (
                <CropPanel
                  adjustments={adjustments}
                  isStraightenActive={isStraightenActive}
                  selectedImage={selectedImage}
                  setAdjustments={setAdjustments}
                  setIsStraightenActive={handleSetIsStraighten}
                  setIsRotationActive={handleSetIsRotation}
                  overlayMode={overlayMode}
                  overlayRotation={overlayRotation}
                  setOverlayRotation={handleSetOverlayRotation}
                  setOverlayMode={handleSetOverlayMode}
                  onLiveRotationChange={handleLiveRotationChange}
                />
              )}
              {renderedRightPanel === Panel.Masks && (
                <MasksPanel
                  onGenerateAiDepthMask={handleGenerateAiDepthMask}
                  onGenerateAiForegroundMask={handleGenerateAiForegroundMask}
                  onGenerateAiSkyMask={handleGenerateAiSkyMask}
                  setAdjustments={setAdjustments}
                  setCustomEscapeHandler={setCustomEscapeHandler}
                />
              )}
              {renderedRightPanel === Panel.Presets && (
                <PresetsPanel
                  activePanel={activeRightPanel}
                  adjustments={adjustments}
                  selectedImage={selectedImage}
                  onNavigateToCommunity={() => {
                    handleBackToLibrary();
                    setUI({ activeView: 'community' });
                  }}
                  setAdjustments={setAdjustments}
                />
              )}
              {renderedRightPanel === Panel.Export && (
                <ExportPanel
                  adjustments={adjustments}
                  exportState={exportState}
                  multiSelectedPaths={multiSelectedPaths}
                  selectedImage={selectedImage}
                  setExportState={setExportState}
                  appSettings={appSettings}
                  onSettingsChange={handleSettingsChange}
                  rootPath={rootPath}
                />
              )}
              {renderedRightPanel === Panel.Ai && (
                <AIPanel
                  activePatchContainerId={activeAiPatchContainerId}
                  activeSubMaskId={activeAiSubMaskId}
                  adjustments={adjustments}
                  aiModelDownloadStatus={aiModelDownloadStatus}
                  brushSettings={brushSettings}
                  isAIConnectorConnected={isAIConnectorConnected}
                  isGeneratingAi={isGeneratingAi}
                  isGeneratingAiMask={isGeneratingAiMask}
                  onDeletePatch={handleDeleteAiPatch}
                  onGenerateAiForegroundMask={handleGenerateAiForegroundMask}
                  onGenerativeReplace={handleGenerativeReplace}
                  onSelectPatchContainer={handleSelectAiPatch}
                  onSelectSubMask={handleSelectAiSubMask}
                  onTogglePatchVisibility={handleToggleAiPatchVisibility}
                  selectedImage={selectedImage}
                  setAdjustments={setAdjustments}
                  setBrushSettings={handleSetBrushSettings}
                  setCustomEscapeHandler={setCustomEscapeHandler}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      );

      return (
        <div className={clsx('flex grow h-full min-h-0', isCompactPortrait ? 'flex-col gap-2' : 'flex-row')}>
          <div className={clsx('flex-1 flex flex-col min-w-0', isCompactPortrait && 'min-h-0')}>
            {editorNode}
            {!isCompactPortrait && editorBottomBarNode}
          </div>
          <div
            className={clsx(
              'flex overflow-hidden shrink-0',
              isCompactPortrait ? 'flex-col bg-bg-secondary rounded-lg' : 'h-full bg-transparent',
              !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
            )}
            style={
              isCompactPortrait
                ? {
                    height: isFullScreen
                      ? '0px'
                      : `${activeRightPanel ? compactEditorPanelHeight : compactEditorPanelCollapsedHeight}px`,
                    opacity: isFullScreen ? 0 : 1,
                  }
                : {
                    maxWidth: isFullScreen ? '0px' : '1000px',
                    opacity: isFullScreen ? 0 : 1,
                  }
            }
          >
            {isCompactPortrait ? (
              <>
                {activeRightPanel && !isFullScreen && (
                  <Resizer
                    direction={Orientation.Horizontal}
                    onMouseDown={createResizeHandler('compact', compactEditorPanelHeight)}
                  />
                )}
                <div className="min-h-0 flex-1 overflow-hidden">{editorRightPanelContent}</div>
                <div className="shrink-0 border-t border-surface">
                  <RightPanelSwitcher
                    activePanel={activeRightPanel}
                    onPanelSelect={handleRightPanelSelect}
                    isInstantTransition={isInstantTransition}
                    layout="horizontal"
                  />
                </div>
                <div className="shrink-0 border-t border-surface">{editorBottomBarComponent}</div>
              </>
            ) : (
              <>
                <Resizer direction={Orientation.Vertical} onMouseDown={createResizeHandler('right', rightPanelWidth)} />
                <div className="flex bg-bg-secondary rounded-lg h-full">
                  <div
                    className={clsx(
                      'h-full overflow-hidden',
                      !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
                    )}
                    style={{ width: activeRightPanel ? `${rightPanelWidth}px` : '0px' }}
                  >
                    <div style={{ width: `${rightPanelWidth}px` }} className="h-full">
                      {editorRightPanelContent}
                    </div>
                  </div>
                  <div
                    className={clsx(
                      'h-full border-l transition-colors',
                      activeRightPanel ? 'border-surface' : 'border-transparent',
                    )}
                  >
                    <RightPanelSwitcher
                      activePanel={activeRightPanel}
                      onPanelSelect={handleRightPanelSelect}
                      isInstantTransition={isInstantTransition}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      );
    }
    return renderLibraryView();
  };

  const renderContent = () => {
    return renderMainView();
  };

  const shouldHideFolderTree = isAndroid;
  const isWgpuActive = appSettings?.useWgpuRenderer !== false && selectedImage?.isReady && hasRenderedFirstFrame;
  const useMacWindowShell = osPlatform === 'macos' && !appSettings?.decorations && !isWindowFullScreen && !isFullScreen;

  useEffect(() => {
    if (selectedImage?.path && selectedImage.isReady && (finalPreviewUrl || isWgpuActive)) {
      cachedEditStateRef.current = {
        adjustments,
        histogram,
        waveform,
        finalPreviewUrl,
        uncroppedPreviewUrl: uncroppedAdjustedPreviewUrl,
        selectedImage,
        originalSize,
        previewSize,
      };
    } else {
      cachedEditStateRef.current = null;
    }
  }, [
    selectedImage,
    adjustments,
    histogram,
    waveform,
    finalPreviewUrl,
    uncroppedAdjustedPreviewUrl,
    originalSize,
    previewSize,
    isWgpuActive,
  ]);

  return (
    <div
      className={clsx(
        'flex flex-col h-screen font-sans text-text-primary overflow-hidden select-none',
        useMacWindowShell && 'macos-window-shell',
        isWgpuActive ? 'bg-transparent' : 'bg-bg-primary',
      )}
    >
      <div
        className={clsx(
          'shrink-0 overflow-hidden z-50',
          !isInstantTransition && 'transition-all duration-300 ease-in-out',
          isFullScreen ? 'max-h-0 opacity-0 pointer-events-none' : 'max-h-[60px] opacity-100',
        )}
      >
        {appSettings?.decorations || (!isWindowFullScreen && <TitleBar />)}
      </div>
      <div
        className={clsx(
          'flex-1 flex flex-col min-h-0',
          isLayoutReady && rootPath && !isInstantTransition && 'transition-all duration-300 ease-in-out',
          [rootPath && (isFullScreen ? 'p-0 gap-0' : 'p-2 gap-2')],
        )}
      >
        <div className="flex flex-row grow h-full min-h-0">
          {!shouldHideFolderTree && renderFolderTree()}
          <div className="flex-1 flex flex-col min-w-0">{renderContent()}</div>
          {!selectedImage && isLibraryExportPanelVisible && (
            <Resizer direction={Orientation.Vertical} onMouseDown={createResizeHandler('right', rightPanelWidth)} />
          )}
          <div
            className={clsx(
              'shrink-0 overflow-hidden',
              !isResizing && !isInstantTransition && 'transition-all duration-300 ease-in-out',
            )}
            style={{ width: isLibraryExportPanelVisible && !isFullScreen ? `${rightPanelWidth}px` : '0px' }}
          >
            <LibraryExportPanel
              exportState={exportState}
              imageList={sortedImageList}
              isVisible={isLibraryExportPanelVisible}
              multiSelectedPaths={multiSelectedPaths}
              onClose={() => setUI({ isLibraryExportPanelVisible: false })}
              setExportState={setExportState}
              appSettings={appSettings}
              onSettingsChange={handleSettingsChange}
              rootPath={rootPath}
            />
          </div>
        </div>
      </div>
      <AppModals
        handleImageSelect={handleImageSelect}
        handleSavePanorama={handleSavePanorama}
        handleStartPanorama={handleStartPanorama}
        handleSaveHdr={handleSaveHdr}
        handleStartHdr={handleStartHdr}
        refreshImageList={refreshImageList}
        handleApplyDenoise={handleApplyDenoise}
        handleBatchDenoise={handleBatchDenoise}
        handleSaveDenoisedImage={handleSaveDenoisedImage}
        handleCreateFolder={handleCreateFolder}
        handleRenameFolder={handleRenameFolder}
        handleSaveRename={handleSaveRename}
        handleStartImport={handleStartImport}
        handleSetColorLabel={handleSetColorLabel}
        handleRate={handleRate}
        executeDelete={executeDelete}
        handleSaveCollage={handleSaveCollage}
      />
      <ToastContainer
        position="bottom-right"
        autoClose={5000}
        hideProgressBar={false}
        newestOnTop
        closeOnClick
        rtl={false}
        pauseOnFocusLoss
        draggable={false}
        pauseOnHover
        theme={isLightTheme ? 'light' : 'dark'}
        transition={Slide}
        toastClassName={() =>
          clsx(
            'relative flex min-h-16 p-4 rounded-lg justify-between overflow-hidden cursor-pointer mb-4',
            'bg-surface! text-text-primary! border! border-border-color! shadow-2xl! max-w-[420px]!',
          )
        }
      />
    </div>
  );
}

const AppWrapper = () => (
  <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
    <ContextMenuProvider>
      <App />
      <GlobalTooltip />
    </ContextMenuProvider>
  </ClerkProvider>
);

export default AppWrapper;
