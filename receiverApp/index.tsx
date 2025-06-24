import { Buffer } from 'buffer';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Button,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  ToastAndroid,
  View,
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { LineChart, Grid, XAxis, YAxis } from 'react-native-svg-charts';
import * as scale from 'd3-scale';

(global as any).Buffer = Buffer;

const SERVICE_UUID = '181A';
const CHARACTERISTIC_UUID = '2A6E';
const TARGET_NAME = 'TRANSMITTER';

const MAX_GRAPH_SECONDS = 10;

export default function App() {
  const bleManager = useRef(new BleManager()).current;
  const baselineRef = useRef<number | null>(null);
  const scanTimerRef = useRef<NodeJS.Timer | null>(null);

  const [Baseline, setBaseline] = useState<number | null>(null);
  const [Vref, setVref] = useState<number | null>(null);
  const [Reading, setReading] = useState<number | null>(null);
  const [Value, setValue] = useState<number | null>(null);

  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [scanTime, setScanTime] = useState<number>(0);

  // Holds timestamped data for the graph
  const [graphData, setGraphData] = useState<{ x: number; y: number }[]>([]);
  const maxXRef = useRef(0.5); // Keep track of max x to smooth dynamic axis

  function updateBaseline(value: number) {
    baselineRef.current = value;
    setBaseline(value);
  }

  async function requestPermissions() {
    if (Platform.OS === 'android') {
      if (Platform.Version < 31) {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: 'Location Permission Required',
            message: 'Location permission is needed to scan for BLE devices',
            buttonPositive: 'OK',
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } else {
        const grantedScan = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          {
            title: 'Bluetooth Scan Permission Required',
            message: 'Bluetooth scan permission is needed to find devices',
            buttonPositive: 'OK',
          }
        );
        const grantedConnect = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          {
            title: 'Bluetooth Connect Permission Required',
            message: 'Bluetooth connect permission is needed to connect to devices',
            buttonPositive: 'OK',
          }
        );
        return (
          grantedScan === PermissionsAndroid.RESULTS.GRANTED &&
          grantedConnect === PermissionsAndroid.RESULTS.GRANTED
        );
      }
    }
    return true;
  }

  async function startScanAndConnect() {
    const permission = await requestPermissions();
    if (!permission) {
      setConnecting(false);
      return;
    }

    setScanTime(0);
    setConnecting(true);

    if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    scanTimerRef.current = setInterval(() => {
      setScanTime((prev) => prev + 1);
    }, 1000);

    bleManager.startDeviceScan(null, null, async (error, device) => {
      if (error) {
        console.warn('Scan error:', error);
        bleManager.stopDeviceScan();
        clearInterval(scanTimerRef.current!);
        setConnecting(false);
        return;
      }

      if (device?.name === TARGET_NAME) {
        bleManager.stopDeviceScan();
        clearInterval(scanTimerRef.current!);

        try {
          const connected = await device.connect();
          await connected.discoverAllServicesAndCharacteristics();
          setConnectedDevice(connected);
          monitorNotifications(connected);

          ToastAndroid.show(`Connected in ${scanTime} seconds.`, ToastAndroid.SHORT);

          connected.onDisconnected(() => {
            ToastAndroid.show('Device disconnected', ToastAndroid.SHORT);
            disconnect();
          });
        } catch (e) {
          console.warn('Connection failed:', e);
          ToastAndroid.show('Connection failed', ToastAndroid.SHORT);
        }

        setConnecting(false);
        setScanTime(0);
      }
    });
  }

  function monitorNotifications(device: Device) {
    device.monitorCharacteristicForService(
      SERVICE_UUID,
      CHARACTERISTIC_UUID,
      (error, characteristic) => {
        if (error) {
          console.warn('Notification error:', error);
          disconnect();
          return;
        }

        if (characteristic?.value) {
          const decoded = Buffer.from(characteristic.value, 'base64').toString('utf-8');
          const isValid = /^[BV]-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(decoded);
          if (!isValid) return;

          const type = decoded.charAt(0);
          const [firstStr, secondStr] = decoded.slice(1).split(',');
          const firstFloat = parseFloat(firstStr);
          const secondFloat = parseFloat(secondStr);

          if (isNaN(firstFloat) || isNaN(secondFloat)) return;

          setReading(secondFloat);

          if (type === 'B') {
            updateBaseline(firstFloat);
          } else if (type === 'V') {
            setVref(firstFloat);
          }

          if (baselineRef.current !== null) {
            const newValue = secondFloat - baselineRef.current;
            setValue(newValue);

            // Update max X for axis scaling, but smooth it
            if (newValue > maxXRef.current) {
              maxXRef.current = newValue;
            } else {
              maxXRef.current = maxXRef.current * 0.95 + newValue * 0.05; // smoothing factor
            }

            // Update graph data (keep last 10 seconds)
            setGraphData((data) => {
              const now = Date.now();
              const cutoff = now - MAX_GRAPH_SECONDS * 1000;
              const filtered = data.filter((item) => item.y > 0 && item.timestamp > cutoff);
              return [
                ...filtered,
                { x: newValue, y: scanTime, timestamp: now } as any,
              ].slice(-100); // limit max points
            });
          }
        }
      }
    );
  }

  async function disconnect() {
    if (connectedDevice) {
      try {
        await connectedDevice.cancelConnection();
      } catch (e) {
        console.warn('Disconnect error:', e);
      }
    }
    setConnectedDevice(null);
    setBaseline(null);
    setVref(null);
    setReading(null);
    setValue(null);
    setConnecting(false);
    if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    setGraphData([]);
    maxXRef.current = 0.5;
  }

  useEffect(() => {
    return () => {
      bleManager.destroy();
      if (scanTimerRef.current) clearInterval(scanTimerRef.current);
    };
  }, []);

  // Prepare graph data - map to {x, y} with y inverted to increase downwards
  const filteredGraphData = graphData
    .filter((item) => item.y !== undefined)
    .map(({ x, y }) => ({ x, y: MAX_GRAPH_SECONDS - y }));

  // X axis max value (smooth)
  const maxX = Math.max(0.5, maxXRef.current * 1.1);

  // Y axis ticks for time 0..MAX_GRAPH_SECONDS
  const yTicks = Array.from({ length: MAX_GRAPH_SECONDS + 1 }, (_, i) => i);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Remote Vane Tester</Text>

      {connecting && (
        <>
          <ActivityIndicator size="large" color="#0000ff" style={{ marginBottom: 10 }} />
          <Text>Scanning... {scanTime}s</Text>
          <Button title="Retry" onPress={startScanAndConnect} />
        </>
      )}

      {!connecting && !connectedDevice && (
        <>
          <Text>Not connected</Text>
          <Button title="Connect" onPress={startScanAndConnect} />
        </>
      )}

      {connectedDevice && (
        <>
          <Text style={styles.connectedText}>Connected to {connectedDevice.name}</Text>
          <View style={styles.dataContainer}>
            <Text style={styles.dataText}>
              Baseline: {Baseline !== null ? Baseline.toFixed(6) : '...'}
            </Text>
            <Text style={styles.dataText}>
              Vref: {Vref !== null ? Vref.toFixed(6) : '...'}
            </Text>
            <Text style={styles.dataText}>
              Reading: {Reading !== null ? Reading.toFixed(6) : '...'}
            </Text>
            <Text style={styles.dataText}>
              Value: {Value !== null ? Value.toFixed(6) : '...'}
            </Text>
          </View>

          {/* Graph with labeled axes */}
          <View style={{ height: 240, flexDirection: 'row', paddingHorizontal: 10, marginTop: 20 }}>
            {/* Y Axis */}
            <View style={{ marginRight: 5 }}>
              <YAxis
                style={{ height: 200 }}
                data={yTicks}
                numberOfTicks={MAX_GRAPH_SECONDS + 1}
                formatLabel={(value) => `${value}`}
                contentInset={{ top: 10, bottom: 10 }}
                svg={{ fontSize: 10, fill: 'black' }}
                min={0}
                max={MAX_GRAPH_SECONDS}
                scale={scale.scaleLinear}
              />
              <Text
                style={{
                  fontSize: 12,
                  textAlign: 'center',
                  marginTop: 5,
                  transform: [{ rotate: '-90deg' }],
                  width: 200,
                  alignSelf: 'center',
                }}
              >
                Time (s)
              </Text>
            </View>

            {/* Chart + X Axis */}
            <View style={{ flex: 1 }}>
              <LineChart
                style={{ height: 200 }}
                data={filteredGraphData}
                yAccessor={({ item }) => item.y}
                xAccessor={({ item }) => item.x}
                svg={{ stroke: 'rgb(34, 128, 176)', strokeWidth: 2 }}
                contentInset={{ top: 10, bottom: 10, left: 10, right: 10 }}
                xMin={-0.1}
                xMax={maxX}
                yMin={0}
                yMax={MAX_GRAPH_SECONDS}
                scale={scale.scaleLinear}
                numberOfTicks={MAX_GRAPH_SECONDS}
              >
                <Grid direction={Grid.Direction.HORIZONTAL} />
              </LineChart>

              <XAxis
                style={{ marginTop: 5 }}
                data={[...Array(5).keys()].map(i => -0.1 + (maxX + 0.1) * (i / 4))} // 5 ticks
                formatLabel={(value) => value.toFixed(2)}
                svg={{ fontSize: 10, fill: 'black' }}
                scale={scale.scaleLinear}
                contentInset={{ left: 10, right: 10 }}
              />

              <Text style={{ textAlign: 'center', fontSize: 12, marginTop: 4 }}>Value (V)</Text>
            </View>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, marginTop: 40 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  connectedText: { fontSize: 18, fontWeight: 'bold', marginBottom: 10 },
  dataContainer: {
    marginTop: 20,
    padding: 15,
    borderWidth: 1,
    borderColor: '#ccc',
    backgroundColor: '#f9f9f9',
  },
  dataText: { fontSize: 16, marginBottom: 8, fontFamily: 'monospace' },
});
