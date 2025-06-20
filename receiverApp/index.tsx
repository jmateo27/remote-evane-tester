import { Buffer } from 'buffer';
import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  FlatList,
  PermissionsAndroid,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';

(global as any).Buffer = Buffer;

const SERVICE_UUID = '181A';
const CHARACTERISTIC_UUID = '2A6E';
const TARGET_NAME = 'TRANSMITTER';

export default function App() {
  const bleManager = useRef(new BleManager()).current;
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);

  // Variables requested
  const [Baseline, setBaseline] = useState<number | null>(null);
  const [Vref, setVref] = useState<number | null>(null);
  const [Reading, setReading] = useState<number | null>(null);
  const [Value, setValue] = useState<number | null>(null);

  const readInterval = useRef<NodeJS.Timeout | null>(null);

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
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert('Permission Denied', 'Cannot scan without location permission');
          return false;
        }
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
        if (
          grantedScan !== PermissionsAndroid.RESULTS.GRANTED ||
          grantedConnect !== PermissionsAndroid.RESULTS.GRANTED
        ) {
          Alert.alert('Permission Denied', 'Cannot scan/connect without Bluetooth permissions');
          return false;
        }
      }
    }
    return true;
  }

  async function startScan() {
    const permission = await requestPermissions();
    if (!permission) return;

    setDevices([]);
    setScanning(true);

    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.warn('Scan error:', error);
        setScanning(false);
        return;
      }
      if (device && device.name === TARGET_NAME) {
        setDevices((prev) => {
          if (prev.find((d) => d.id === device.id)) return prev;
          return [...prev, device];
        });
      }
    });

    setTimeout(() => {
      bleManager.stopDeviceScan();
      setScanning(false);
    }, 10000);
  }

  async function connectToDevice(device: Device) {
    try {
      bleManager.stopDeviceScan();
      setScanning(false);

      const connected = await device.connect();
      await connected.discoverAllServicesAndCharacteristics();

      setConnectedDevice(connected);
      Alert.alert('Connected', `Connected to ${device.name}`);

      // Poll characteristic every 200ms
      readInterval.current = setInterval(async () => {
        try {
          const characteristic = await connected.readCharacteristicForService(
            SERVICE_UUID,
            CHARACTERISTIC_UUID
          );
          if (characteristic?.value) {
            const decoded = Buffer.from(characteristic.value, 'base64').toString('utf-8');
            // Parse message here:
            // Format: B<float>,<float> or V<float>,<float>
            // Example: B0.650332,0.657583
            const type = decoded.charAt(0);
            const rest = decoded.substring(1);
            const parts = rest.split(',');

            if (parts.length === 2) {
              const firstFloat = parseFloat(parts[0]);
              const secondFloat = parseFloat(parts[1]);

              if (type === 'B') {
                setBaseline(firstFloat);
              } else if (type === 'V') {
                setVref(firstFloat);
              }
              setReading(secondFloat);

              // Value = Reading - Baseline (only if Baseline is defined)
              setValue((prev) => {
                if (type === 'B') {
                  // When baseline updates, recalc value if Reading exists
                  return secondFloat !== null && !isNaN(secondFloat) ? secondFloat - firstFloat : null;
                } else {
                  return (secondFloat !== null && !isNaN(secondFloat) && Baseline !== null) ? secondFloat - Baseline : prev;
                }
              });
            }
          }
        } catch (e) {
          console.warn('Read error:', e);
        }
      }, 200);
    } catch (error) {
      console.warn('Connection error:', error);
      Alert.alert('Connection failed', 'Failed to connect to device');
    }
  }

  async function disconnect() {
    if (connectedDevice) {
      try {
        if (readInterval.current) {
          clearInterval(readInterval.current);
          readInterval.current = null;
        }
        await connectedDevice.cancelConnection();
      } catch (e) {
        console.warn('Disconnect error:', e);
      }
      setConnectedDevice(null);
      setBaseline(null);
      setVref(null);
      setReading(null);
      setValue(null);
    }
  }

  useEffect(() => {
    return () => {
      bleManager.destroy();
      if (readInterval.current) {
        clearInterval(readInterval.current);
      }
    };
  }, []);

  return (
    <View style={styles.container}>
      {!connectedDevice ? (
        <>
          <Button
            title={scanning ? 'Scanning...' : 'Scan for Transmitter'}
            onPress={startScan}
            disabled={scanning}
          />
          <FlatList
            data={devices}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.deviceItem} onPress={() => connectToDevice(item)}>
                <Text style={styles.deviceName}>{item.name}</Text>
                <Text style={styles.deviceId}>{item.id}</Text>
              </TouchableOpacity>
            )}
            ListEmptyComponent={<Text style={{ marginTop: 20 }}>No devices found yet.</Text>}
          />
        </>
      ) : (
        <>
          <Text style={styles.connectedText}>Connected to {connectedDevice.name}</Text>
          <Button title="Disconnect" onPress={disconnect} />

          <View style={styles.dataContainer}>
            <Text style={styles.dataText}>Baseline: {Baseline !== null ? Baseline.toFixed(6) : 'N/A'}</Text>
            <Text style={styles.dataText}>Vref: {Vref !== null ? Vref.toFixed(6) : 'N/A'}</Text>
            <Text style={styles.dataText}>Reading: {Reading !== null ? Reading.toFixed(6) : 'N/A'}</Text>
            <Text style={styles.dataText}>Value: {Value !== null ? Value.toFixed(6) : 'N/A'}</Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, marginTop: 40 },
  deviceItem: { padding: 15, borderBottomWidth: 1, borderColor: '#ccc' },
  deviceName: { fontSize: 16, fontWeight: 'bold' },
  deviceId: { fontSize: 12, color: '#666' },
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
