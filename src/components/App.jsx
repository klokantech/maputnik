import React from 'react'
import Mousetrap from 'mousetrap'

import MapboxGlMap from './map/MapboxGlMap'
import OpenLayers3Map from './map/OpenLayers3Map'
import LayerList from './layers/LayerList'
import LayerEditor from './layers/LayerEditor'
import Toolbar from './Toolbar'
import AppLayout from './AppLayout'
import MessagePanel from './MessagePanel'

import { downloadGlyphsMetadata, downloadSpriteMetadata } from '../libs/metadata'
import styleSpec from '@mapbox/mapbox-gl-style-spec/style-spec'
import style from '../libs/style.js'
import { initialStyleId, initialStyleUrl, loadStyleUrl } from '../libs/urlopen'
import { undoMessages, redoMessages } from '../libs/diffmessage'
import { ServerStore } from '../libs/serverstore'
import { RevisionStore } from '../libs/revisions'
import LayerWatcher from '../libs/layerwatcher'
import tokens from '../config/tokens.json'
import isEqual from 'lodash.isequal'
import * as urlState from '../libs/urlstate.js'

import MapboxGl from 'mapbox-gl'
import mapboxUtil from 'mapbox-gl/src/util/mapbox'


function updateRootSpec(spec, fieldName, newValues) {
  return {
    ...spec,
    $root: {
      ...spec.$root,
      [fieldName]: {
        ...spec.$root[fieldName],
        values: newValues
      }
    }
  }
}

const beforeunloadListener = (evt) => {
  evt.returnValue = "Changes to map style are not saved!";
}

export default class App extends React.Component {

  isStyleDiff = false;
  infoTimeout = null;

  constructor(props) {
    super(props)
    this.revisionStore = new RevisionStore()
    this.styleStore = new ServerStore()

    const styleId = initialStyleId()
    this.styleStore.init(err => {
      if(err) {
        console.log('Can not connect to server config');
      } else {
        if(styleId) {
          this.styleStore.loadById(styleId, mapStyle => this.onStyleOpen(mapStyle));
        } else {
          this.styleStore.loadLatestStyle(mapStyle => this.onStyleOpen(mapStyle));
        }
      }
    });

    window.addEventListener('popstate', this.onPopState.bind(this));



    this.state = {
      errors: [],
      infos: [],
      mapStyle: style.emptyStyle,
      selectedLayerIndex: 0,
      sources: {},
      vectorLayers: {},
      inspectModeEnabled: false,
      spec: styleSpec.latest,
    }

    this.layerWatcher = new LayerWatcher({
      onVectorLayersChange: v => this.setState({ vectorLayers: v })
    })
  }

  componentDidMount() {
    this.fetchSources();
    Mousetrap.bind(['ctrl+z'], this.onUndo.bind(this));
    Mousetrap.bind(['ctrl+y'], this.onRedo.bind(this));
  }

  componentWillUnmount() {
    Mousetrap.unbind(['ctrl+z'], this.onUndo.bind(this));
    Mousetrap.unbind(['ctrl+y'], this.onRedo.bind(this));
  }

  onReset() {
    this.styleStore.purge()
    this.styleStore.loadLatestStyle(mapStyle => this.onStyleOpen(mapStyle))
  }

  saveStyle(snapshotStyle) {
    this.styleStore.save(snapshotStyle)
  }

  updateFonts(urlTemplate) {
    const metadata = this.state.mapStyle.metadata || {}
    const accessToken = metadata['maputnik:openmaptiles_access_token'] || tokens.openmaptiles
    downloadGlyphsMetadata(urlTemplate.replace('{key}', accessToken), fonts => {
      this.setState({ spec: updateRootSpec(this.state.spec, 'glyphs', fonts)})
    })
  }

  updateIcons(baseUrl) {
    downloadSpriteMetadata(baseUrl, icons => {
      this.setState({ spec: updateRootSpec(this.state.spec, 'sprite', icons)})
    })
  }

  onPopState(evt) {
    const styleId = evt.state && evt.state.styleId;
    // console.log('onPopState', styleId, this.styleStore.knowsId(styleId))
    if(styleId && this.styleStore.knowsId(styleId)) {
      this.styleStore.loadById(
        styleId,
        mapStyle => this.onStyleOpen(mapStyle)
      )
    } else {
      urlState.replaceState(this.state.mapStyle);
    }
  };

  replaceUrlState() {
    // we need to update it again
    // because state is replaced by mapbox gl js
    // on map load and moveend
    // https://github.com/mapbox/mapbox-gl-js/blob/cd4a19b214c4eefec71afd70cfb2e980656c1533/src/ui/hash.js#L94
    urlState.replaceState(this.state.mapStyle);
  };

  onStyleChanged(newStyle, open=false) {
    if(!open && !this.isStyleDiff) {
      this.isStyleDiff = true;
      window.addEventListener("beforeunload", beforeunloadListener);
    }
    if(newStyle.glyphs !== this.state.mapStyle.glyphs) {
      this.updateFonts(newStyle.glyphs)
    }
    if(newStyle.sprite !== this.state.mapStyle.sprite) {
      this.updateIcons(newStyle.sprite)
    }

    const errors = styleSpec.validate(newStyle, styleSpec.latest)
    if(errors.length === 0) {
      this.revisionStore.addRevision(newStyle)
      urlState.onStyleChange(this.state.mapStyle, newStyle);
      this.setState({
        mapStyle: newStyle,
        errors: [],
      })
    } else {
      this.setState({
        errors: errors.map(err => err.message)
      })
    }

    this.fetchSources();
  }

  onStyleOpen(newStyle) {
    this.revisionStore.clear();
    window.removeEventListener("beforeunload", beforeunloadListener);
    this.isStyleDiff = false;
    this.onStyleChanged(newStyle, true);
  }

  onUndo() {
    const activeStyle = this.revisionStore.undo()
    const messages = undoMessages(this.state.mapStyle, activeStyle)
    //this.saveStyle(activeStyle)
    if(!this.isStyleDiff) {
      this.isStyleDiff = true;
      window.addEventListener("beforeunload", beforeunloadListener);
    }
    this.setState({
      mapStyle: activeStyle,
      infos: messages,
    })
  }

  onRedo() {
    const activeStyle = this.revisionStore.redo()
    const messages = redoMessages(this.state.mapStyle, activeStyle)
    //this.saveStyle(activeStyle)
    if(!this.isStyleDiff) {
      this.isStyleDiff = true;
      window.addEventListener("beforeunload", beforeunloadListener);
    }
    this.setState({
      mapStyle: activeStyle,
      infos: messages,
    })
  }

  onLayersChange(changedLayers) {
    const changedStyle = {
      ...this.state.mapStyle,
      layers: changedLayers
    }
    this.onStyleChanged(changedStyle);
  }

  onLayerIdChange(oldId, newId) {
    const changedLayers = this.state.mapStyle.layers.slice(0)
    const idx = style.indexOfLayer(changedLayers, oldId)

    changedLayers[idx] = {
      ...changedLayers[idx],
      id: newId
    }

    this.onLayersChange(changedLayers)
  }

  onLayerChanged(layer) {
    const changedLayers = this.state.mapStyle.layers.slice(0)
    const idx = style.indexOfLayer(changedLayers, layer.id)
    changedLayers[idx] = layer

    this.onLayersChange(changedLayers)
  }

  changeInspectMode() {
    this.setState({
      inspectModeEnabled: !this.state.inspectModeEnabled
    })
  }

  fetchSources() {
    const sourceList = {...this.state.sources};

    for(let [key, val] of Object.entries(this.state.mapStyle.sources)) {
      if(sourceList.hasOwnProperty(key) || !val.url) {
        continue;
      }

      sourceList[key] = {
        type: val.type,
        layers: []
      };

      if(!this.state.sources.hasOwnProperty(key) && val.type === "vector") {
        let url = val.url;
        try {
          url = mapboxUtil.normalizeSourceURL(url, MapboxGl.accessToken);
        } catch(err) {
          console.warn("Failed to normalizeSourceURL: ", err);
        }

        fetch(url)
          .then((response) => {
            return response.json();
          })
          .then((json) => {
            // Create new objects before setState
            const sources = Object.assign({}, this.state.sources);

            for(let layer of json.vector_layers) {
              sources[key].layers.push(layer.id)
            }

            console.debug("Updating source: "+key);
            this.setState({
              sources: sources
            });
          })
          .catch((err) => {
            console.error("Failed to process sources for '%s'", url, err);
          })
      }
    }

    if(!isEqual(this.state.sources, sourceList)) {
      console.debug("Setting sources");
      this.setState({
        sources: sourceList
      })
    }
  }

  mapRenderer() {
    const mapProps = {
      mapStyle: style.replaceAccessToken(this.state.mapStyle),
      onDataChange: (e) => {
        this.layerWatcher.analyzeMap(e.map)
        this.fetchSources();
      },
    }

    const metadata = this.state.mapStyle.metadata || {}
    const renderer = metadata['maputnik:renderer'] || 'mbgljs'

    // Check if OL3 code has been loaded?
    if(renderer === 'ol3') {
      return <OpenLayers3Map {...mapProps} />
    } else {
      return  <MapboxGlMap {...mapProps}
        inspectModeEnabled={this.state.inspectModeEnabled}
        highlightedLayer={this.state.mapStyle.layers[this.state.selectedLayerIndex]}
        onMapLoad={this.replaceUrlState.bind(this)}
        onMoveEnd={this.replaceUrlState.bind(this)}
        onLayerSelect={this.onLayerSelect.bind(this)} />
    }
  }

  onLayerSelect(layerId) {
    const idx = style.indexOfLayer(this.state.mapStyle.layers, layerId)
    this.setState({ selectedLayerIndex: idx })
  }

  onStyleSave() {
    this.styleStore.save(this.state.mapStyle, (error) => {
      let errors = [];
      let infos = [];
      if(error) {
        errors = [error.message];
      } else {
        infos = ['Style '+ this.state.mapStyle.name+' sucessfully saved.'];
      }
      this.setState({infos, errors});
      if(!error) {
        if (this.infoTimeout) {
          clearTimeout(this.infoTimeout);
        }
        this.infoTimeout = setTimeout(() => {
          this.setState({infos: []});
          this.infoTimeout = null;
        }, 3000);
      }
      window.removeEventListener("beforeunload", beforeunloadListener);
    });
  }

  render() {
    const layers = this.state.mapStyle.layers || []
    const selectedLayer = layers.length > 0 ? layers[this.state.selectedLayerIndex] : null
    const metadata = this.state.mapStyle.metadata || {}

    const toolbar = <Toolbar
      mapStyle={this.state.mapStyle}
      inspectModeEnabled={this.state.inspectModeEnabled}
      sources={this.state.sources}
      onStyleChanged={this.onStyleChanged.bind(this)}
      onStyleOpen={() => {window.location = process.env.TILEHOSTING_URL+'/maps/';}}
      onStyleExport={() => {
        window.location =
          process.env.TILEHOSTING_URL+'/maps/' + this.state.mapStyle.id + '/';
      }}
      onStyleSave={this.onStyleSave.bind(this)}
      onInspectModeToggle={this.changeInspectMode.bind(this)}
      url={process.env.TILEHOSTING_URL+'/maps/style-editor/'}
    />

    const layerList = <LayerList
      onLayersChange={this.onLayersChange.bind(this)}
      onLayerSelect={this.onLayerSelect.bind(this)}
      selectedLayerIndex={this.state.selectedLayerIndex}
      layers={layers}
      sources={this.state.sources}
    />

    const layerEditor = selectedLayer ? <LayerEditor
      layer={selectedLayer}
      sources={this.state.sources}
      vectorLayers={this.state.vectorLayers}
      spec={this.state.spec}
      onLayerChanged={this.onLayerChanged.bind(this)}
      onLayerIdChange={this.onLayerIdChange.bind(this)}
    /> : null

    const bottomPanel = (this.state.errors.length + this.state.infos.length) > 0 ? <MessagePanel
      errors={this.state.errors}
      infos={this.state.infos}
    /> : null

    return <AppLayout
      toolbar={toolbar}
      layerList={layerList}
      layerEditor={layerEditor}
      map={this.mapRenderer()}
      bottom={bottomPanel}
    />
  }
}
