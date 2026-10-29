export type SemsPlant = {
  id: string;
  name: string;
};

export type SemsInverter = {
  id: string;
  name: string;
  serialNumber: string | null;
  status: string;
  powerKw: number;
  dayGenerationKwh: number;
  monthGenerationKwh?: number;
  totalGenerationKwh: number;
  ratedPowerKw?: number;
};

export type SemsHourlyPoint = {
  timestamp: string;
  powerKw: number;
};

export type SemsDailyPoint = {
  date: string;
  generationKwh: number;
};

export type SemsPlantSnapshot = {
  plantId: string;
  plantName: string;
  location: string | null;
  capacityKwp: number | null;
  totalGenerationKwh: number;
  todayGenerationKwh: number;
  monthGenerationKwh: number;
  currentPowerKw: number;
  status: string;
  inverters: SemsInverter[];
  hourlyChart: SemsHourlyPoint[];
  dailyHistory: SemsDailyPoint[];
  monthlyHistory: SemsDailyPoint[];
  unreadableInverters?: string[];
  errorLog?: string;
};
